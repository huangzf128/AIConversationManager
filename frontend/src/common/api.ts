// Shared fetch helpers for talking to the NestJS backend.
// Frontend utilities live under src/common, mirroring the backend convention.
const API_BASE_URL = 'http://localhost:3000';

export async function fetchConversations() {
  const res = await fetch(`${API_BASE_URL}/conversations`);
  return res.json();
}

export async function fetchConversation(id: string) {
  const res = await fetch(`${API_BASE_URL}/conversations/${id}`);
  return res.json();
}