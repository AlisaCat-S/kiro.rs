import { useState, useEffect } from 'react'
import { storage } from '@/lib/storage'
import { LoginPage } from '@/components/login-page'
import { Dashboard } from '@/components/dashboard'
import { NodesManager } from '@/components/nodes-manager'
import { Toaster } from '@/components/ui/sonner'

type Page = 'dashboard' | 'nodes'

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [page, setPage] = useState<Page>('dashboard')

  useEffect(() => {
    if (storage.getApiKey()) {
      setIsLoggedIn(true)
    }
  }, [])

  const handleLogin = () => {
    setIsLoggedIn(true)
  }

  const handleLogout = () => {
    setIsLoggedIn(false)
  }

  if (!isLoggedIn) {
    return (
      <>
        <LoginPage onLogin={handleLogin} />
        <Toaster position="top-right" />
      </>
    )
  }

  return (
    <>
      {page === 'dashboard' ? (
        <Dashboard onLogout={handleLogout} onNavigate={setPage} />
      ) : (
        <div className="min-h-screen bg-background">
          <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
            <div className="container flex h-14 items-center justify-between px-4 md:px-8">
              <div className="flex items-center gap-4">
                <button
                  className="text-sm font-medium text-muted-foreground hover:text-foreground"
                  onClick={() => setPage('dashboard')}
                >
                  ← 返回凭证管理
                </button>
              </div>
              <button
                className="text-sm text-muted-foreground hover:text-foreground"
                onClick={handleLogout}
              >
                退出
              </button>
            </div>
          </header>
          <main className="container mx-auto px-4 md:px-8 py-6">
            <NodesManager />
          </main>
        </div>
      )}
      <Toaster position="top-right" />
    </>
  )
}

export default App
