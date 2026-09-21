// Shared fetch helpers for talking to the NestJS backend.
// Frontend utilities live under src/common, mirroring the backend convention.
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string) || 'http://localhost:3000';

export { API_BASE_URL };

export async function fetchConversations() {
  const res = await fetch(`${API_BASE_URL}/conversations`);
  return res.json();
}

export async function fetchConversation(id: string) {
  const res = await fetch(`${API_BASE_URL}/conversations/${id}`);
  return res.json();
}

export function attachmentDownloadUrl(attachmentId: string) {
  return `${API_BASE_URL}/conversations/attachments/${attachmentId}/download`;
}
