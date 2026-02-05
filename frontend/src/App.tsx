import { Routes, Route, Navigate } from 'react-router-dom'
import { useState, useEffect } from 'react'
import { AuthCallback } from './components/Auth/AuthCallback'
import { LoginPage } from './components/Auth/LoginPage'
import { Dashboard } from './components/Dashboard'
import { Chat } from './components/Chat/Chat'
import { api } from './services/api'

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)
  const [user, setUser] = useState<{ id: string; email: string; name: string } | null>(null)

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (token) {
      api.getMe()
        .then(setUser)
        .then(() => setIsAuthenticated(true))
        .catch(() => {
          localStorage.removeItem('token')
          setIsAuthenticated(false)
        })
    } else {
      setIsAuthenticated(false)
    }
  }, [])

  const handleLogin = (token: string) => {
    localStorage.setItem('token', token)
    api.getMe().then(setUser)
    setIsAuthenticated(true)
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    setUser(null)
    setIsAuthenticated(false)
  }

  if (isAuthenticated === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  return (
    <Routes>
      <Route path="/auth/callback" element={<AuthCallback onLogin={handleLogin} />} />
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" /> : <LoginPage />}
      />
      <Route
        path="/"
        element={
          isAuthenticated ? (
            <Dashboard user={user} onLogout={handleLogout} />
          ) : (
            <Navigate to="/login" />
          )
        }
      />
      <Route
        path="/chat/:folderId"
        element={
          isAuthenticated ? (
            <Chat user={user} onLogout={handleLogout} />
          ) : (
            <Navigate to="/login" />
          )
        }
      />
    </Routes>
  )
}
