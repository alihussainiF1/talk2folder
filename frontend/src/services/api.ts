import axios from 'axios'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8009'

const client = axios.create({
  baseURL: `${API_URL}/api`,
})

client.interceptors.request.use((config) => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

export const api = {
  getAuthUrl: async () => {
    const { data } = await client.get('/auth/login')
    return data.auth_url
  },

  exchangeCode: async (code: string) => {
    const { data } = await client.post('/auth/callback', null, { params: { code } })
    return data.access_token
  },

  getMe: async () => {
    const { data } = await client.get('/auth/me')
    return data
  },

  addFolder: async (folderUrl: string) => {
    const { data } = await client.post('/drive/folders', { folder_url: folderUrl })
    return data
  },

  getFolders: async () => {
    const { data } = await client.get('/drive/folders')
    return data
  },

  getFolder: async (folderId: string) => {
    const { data } = await client.get(`/drive/folders/${folderId}`)
    return data
  },

  deleteFolder: async (folderId: string) => {
    const { data } = await client.delete(`/drive/folders/${folderId}`)
    return data
  },

  reindexFolder: async (folderId: string) => {
    const { data } = await client.post(`/drive/folders/${folderId}/reindex`)
    return data
  },

  sendMessage: async (folderId: string, message: string, conversationId?: string) => {
    const { data } = await client.post('/chat/send', {
      folder_id: folderId,
      message,
      conversation_id: conversationId,
    })
    return data
  },

  /**
   * Stream chat messages using Server-Sent Events (SSE)
   * @param folderId - The folder ID
   * @param message - The user's message
   * @param conversationId - Optional existing conversation ID
   * @param onChunk - Callback for each text chunk received
   * @param onStart - Callback when streaming starts (receives conversation_id)
   * @param onDone - Callback when streaming completes
   * @param onError - Callback for errors
   */
  sendMessageStream: (
    folderId: string,
    message: string,
    conversationId: string | undefined,
    onChunk: (text: string) => void,
    onStart?: (conversationId: string) => void,
    onDone?: (messageId: string, citations?: Array<{file_name: string, file_id?: string, drive_file_id?: string, mime_type?: string}>) => void,
    onError?: (error: string) => void
  ): AbortController => {
    const controller = new AbortController()
    const token = localStorage.getItem('token')
    
    const fetchStream = async () => {
      try {
        const response = await fetch(`${API_URL}/api/chat/send/stream`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({
            folder_id: folderId,
            message,
            conversation_id: conversationId,
          }),
          signal: controller.signal,
        })

        if (!response.ok) {
          const errorText = await response.text()
          onError?.(errorText || 'Failed to start stream')
          return
        }

        const reader = response.body?.getReader()
        if (!reader) {
          onError?.('No reader available')
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (line.startsWith('event:')) {
              const eventType = line.slice(6).trim()
              continue
            }
            if (line.startsWith('data:')) {
              const data = line.slice(5).trim()
              if (!data) continue
              
              try {
                const parsed = JSON.parse(data)
                
                if ('text' in parsed) {
                  onChunk(parsed.text)
                } else if ('conversation_id' in parsed && !('message_id' in parsed)) {
                  onStart?.(parsed.conversation_id)
                } else if ('message_id' in parsed) {
                  onDone?.(parsed.message_id, parsed.citations)
                } else if ('error' in parsed) {
                  onError?.(parsed.error)
                }
              } catch (e) {
                console.warn('Failed to parse SSE data:', data)
              }
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          onError?.((e as Error).message || 'Stream error')
        }
      }
    }

    fetchStream()
    return controller
  },

  getConversations: async (folderId?: string) => {
    const { data } = await client.get('/chat/conversations', {
      params: folderId ? { folder_id: folderId } : {},
    })
    return data
  },

  getConversation: async (conversationId: string) => {
    const { data } = await client.get(`/chat/conversations/${conversationId}`)
    return data
  },

  getFolderFiles: async (folderId: string) => {
    const { data } = await client.get(`/drive/folders/${folderId}/files`)
    return data
  },

  getFileViewUrl: (folderId: string, fileId: string) => {
    const token = localStorage.getItem('token')
    return `${API_URL}/api/drive/folders/${folderId}/files/${fileId}/view?token=${token}`
  },

  getPdfInfo: async (folderId: string, fileId: string) => {
    const { data } = await client.get(`/drive/folders/${folderId}/files/${fileId}/pdf-info`)
    return data
  },

  splitPdf: async (folderId: string, fileId: string, pages?: number[], splitAll?: boolean) => {
    const { data } = await client.post(`/drive/folders/${folderId}/files/${fileId}/split`, {
      pages,
      split_all: splitAll,
    })
    return data
  },

  getSplitPageUrl: (folderId: string, fileId: string, pageNum: number) => {
    const token = localStorage.getItem('token')
    return `${API_URL}/api/drive/folders/${folderId}/files/${fileId}/split/${pageNum}?token=${token}`
  },
}
