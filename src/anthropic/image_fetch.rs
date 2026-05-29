use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use reqwest::redirect;
use std::net::IpAddr;
use std::time::Duration;

use super::types::MessagesRequest;

const MAX_IMAGE_SIZE: usize = 20 * 1024 * 1024; // 20MB
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REDIRECTS: usize = 3;
const MAX_CONCURRENT_DOWNLOADS: usize = 5;

#[derive(Debug)]
pub enum ImageFetchError {
    InvalidUrl(String),
    PrivateIp(String),
    Timeout,
    TooLarge,
    UnsupportedFormat,
    NetworkError(String),
}

impl std::fmt::Display for ImageFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl(url) => write!(f, "invalid URL: {}", url),
            Self::PrivateIp(ip) => write!(f, "private/reserved IP blocked: {}", ip),
            Self::Timeout => write!(f, "download timed out"),
            Self::TooLarge => write!(f, "image exceeds 20MB size limit"),
            Self::UnsupportedFormat => write!(f, "unsupported image format"),
            Self::NetworkError(msg) => write!(f, "network error: {}", msg),
        }
    }
}

fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || (v4.octets()[0] == 169 && v4.octets()[1] == 254)
                || v4.is_broadcast()
                || v4.is_unspecified()
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_private_ip(&IpAddr::V4(v4));
            }
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // ULA (fc00::/7)
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // link-local (fe80::/10)
        }
    }
}

fn detect_image_format(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 12 {
        return None;
    }
    if bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Some("jpeg");
    }
    if bytes[0..8] == [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] {
        return Some("png");
    }
    if bytes[0..4] == [0x47, 0x49, 0x46, 0x38] {
        return Some("gif");
    }
    if bytes[0..4] == [0x52, 0x49, 0x46, 0x46] && bytes[8..12] == [0x57, 0x45, 0x42, 0x50] {
        return Some("webp");
    }
    None
}

async fn validate_url(url: &str) -> Result<(), ImageFetchError> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| ImageFetchError::InvalidUrl(url.to_string()))?;

    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err(ImageFetchError::InvalidUrl(format!("unsupported scheme: {}", parsed.scheme()))),
    }

    let host = parsed.host_str()
        .ok_or_else(|| ImageFetchError::InvalidUrl("no host".to_string()))?;

    let addrs = tokio::net::lookup_host(format!("{}:{}", host, parsed.port_or_known_default().unwrap_or(80)))
        .await
        .map_err(|e| ImageFetchError::NetworkError(format!("DNS resolution failed: {}", e)))?;

    for addr in addrs {
        if is_private_ip(&addr.ip()) {
            return Err(ImageFetchError::PrivateIp(addr.ip().to_string()));
        }
    }

    Ok(())
}

pub async fn fetch_image_from_url(url: &str) -> Result<(String, String), ImageFetchError> {
    validate_url(url).await?;

    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TOTAL_TIMEOUT)
        .redirect(redirect::Policy::none())
        .build()
        .map_err(|e| ImageFetchError::NetworkError(e.to_string()))?;

    let mut current_url = url.to_string();
    let mut redirects = 0;

    loop {
        let resp = client
            .get(&current_url)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    ImageFetchError::Timeout
                } else {
                    ImageFetchError::NetworkError(e.to_string())
                }
            })?;

        if resp.status().is_redirection() {
            redirects += 1;
            if redirects > MAX_REDIRECTS {
                return Err(ImageFetchError::NetworkError("too many redirects".to_string()));
            }
            let location = resp
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| ImageFetchError::NetworkError("redirect without location".to_string()))?;

            let next_url = reqwest::Url::parse(location)
                .or_else(|_| reqwest::Url::parse(&current_url).and_then(|base| base.join(location)))
                .map_err(|_| ImageFetchError::InvalidUrl(location.to_string()))?;

            current_url = next_url.to_string();
            validate_url(&current_url).await?;
            continue;
        }

        if !resp.status().is_success() {
            return Err(ImageFetchError::NetworkError(format!("HTTP {}", resp.status())));
        }

        if let Some(len) = resp.content_length() {
            if len as usize > MAX_IMAGE_SIZE {
                return Err(ImageFetchError::TooLarge);
            }
        }

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    ImageFetchError::Timeout
                } else {
                    ImageFetchError::NetworkError(e.to_string())
                }
            })?;

        if bytes.len() > MAX_IMAGE_SIZE {
            return Err(ImageFetchError::TooLarge);
        }

        let format = detect_image_format(&bytes)
            .ok_or(ImageFetchError::UnsupportedFormat)?;

        let base64_data = BASE64.encode(&bytes);

        return Ok((format.to_string(), base64_data));
    }
}

/// 预处理请求中的 URL 图片，下载并转换为 base64 格式
pub async fn resolve_url_images(req: &mut MessagesRequest) -> Result<(), ImageFetchError> {
    let mut tasks: Vec<(usize, usize, String)> = Vec::new();

    for (msg_idx, msg) in req.messages.iter().enumerate() {
        if let serde_json::Value::Array(arr) = &msg.content {
            for (block_idx, item) in arr.iter().enumerate() {
                if item.get("type").and_then(|v| v.as_str()) == Some("image") {
                    if let Some(source) = item.get("source") {
                        if source.get("type").and_then(|v| v.as_str()) == Some("url") {
                            if let Some(url) = source.get("url").and_then(|v| v.as_str()) {
                                tasks.push((msg_idx, block_idx, url.to_string()));
                            }
                        }
                    }
                }
            }
        }
    }

    if tasks.is_empty() {
        return Ok(());
    }

    tracing::info!("发现 {} 个 URL 图片，开始下载", tasks.len());

    // 分批下载，每批最多 MAX_CONCURRENT_DOWNLOADS 个
    for chunk in tasks.chunks(MAX_CONCURRENT_DOWNLOADS) {
        let futures: Vec<_> = chunk
            .iter()
            .map(|(_, _, url)| fetch_image_from_url(url))
            .collect();

        let results = futures::future::join_all(futures).await;

        for (i, result) in results.into_iter().enumerate() {
            let (msg_idx, block_idx, ref url) = chunk[i];
            match result {
                Ok((format, base64_data)) => {
                    let media_type = format!("image/{}", format);
                    let new_block = serde_json::json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": base64_data
                        }
                    });
                    if let serde_json::Value::Array(arr) = &mut req.messages[msg_idx].content {
                        arr[block_idx] = new_block;
                    }
                    tracing::debug!("URL 图片下载成功: {}", url);
                }
                Err(e) => {
                    tracing::warn!("URL 图片下载失败: {} - {}", url, e);
                    return Err(e);
                }
            }
        }
    }

    Ok(())
}
