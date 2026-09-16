import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import { ChatgptParser } from './chatgpt.parser.js';

describe('ChatgptParser', () => {
  const parser = new ChatgptParser();

  it('returns empty for invalid JSON', () => {
    expect(parser.parse('not json')).toEqual([]);
  });

  it('returns empty for non-array JSON', () => {
    expect(parser.parse('{}')).toEqual([]);
  });

  it('parses a simple linear conversation', () => {
    const raw = JSON.stringify([
      {
        id: 'conv-1',
        conversation_id: 'conv-1',
        title: 'Hello Chat',
        create_time: 1700000000.0,
        update_time: 1700000100.0,
        current_node: 'node-assistant',
        mapping: {
          'node-root': {
            id: 'node-root',
            message: null,
            parent: null,
            children: ['node-user'],
          },
          'node-user': {
            id: 'node-user',
            message: {
              id: 'msg-user',
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['Hello!'] },
              create_time: 1700000050.0,
              metadata: {},
            },
            parent: 'node-root',
            children: ['node-assistant'],
          },
          'node-assistant': {
            id: 'node-assistant',
            message: {
              id: 'msg-assistant',
              author: { role: 'assistant' },
              content: { content_type: 'text', parts: ['Hi there!'] },
              create_time: 1700000100.0,
              metadata: { model_slug: 'gpt-4o' },
            },
            parent: 'node-user',
            children: [],
          },
        },
      },
    ]);

    const result = parser.parse(raw);
    expect(result).toHaveLength(1);

    const conv = result[0];
    expect(conv.id).toBe('conv-1');
    expect(conv.platform).toBe('chatgpt');
    expect(conv.title).toBe('Hello Chat');
    expect(conv.messages).toHaveLength(2);
    expect(conv.messages[0].role).toBe('user');
    expect(conv.messages[0].content).toBe('Hello!');
    expect(conv.messages[1].role).toBe('assistant');
    expect(conv.messages[1].content).toBe('Hi there!');
  });

  it('derives title from first user message when title is missing', () => {
    const raw = JSON.stringify([
      {
        id: 'conv-2',
        create_time: 1700000000.0,
        update_time: 1700000100.0,
        current_node: 'node-assistant',
        mapping: {
          'node-root': {
            id: 'node-root',
            message: null,
            parent: null,
            children: ['node-user'],
          },
          'node-user': {
            id: 'node-user',
            message: {
              id: 'msg-user',
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['Explain quantum computing in simple terms'] },
              create_time: 1700000050.0,
              metadata: {},
            },
            parent: 'node-root',
            children: ['node-assistant'],
          },
          'node-assistant': {
            id: 'node-assistant',
            message: {
              id: 'msg-assistant',
              author: { role: 'assistant' },
              content: { content_type: 'text', parts: ['Quantum computing uses qubits...'] },
              create_time: 1700000100.0,
              metadata: {},
            },
            parent: 'node-user',
            children: [],
          },
        },
      },
    ]);

    const result = parser.parse(raw);
    expect(result[0].title).toBe('Explain quantum computing in simple terms');
  });

  it('handles branched conversation by following last child', () => {
    const raw = JSON.stringify([
      {
        id: 'conv-3',
        create_time: 1700000000.0,
        update_time: 1700000200.0,
        current_node: 'node-assistant-v2',
        mapping: {
          'node-root': {
            id: 'node-root',
            message: null,
            parent: null,
            children: ['node-user'],
          },
          'node-user': {
            id: 'node-user',
            message: {
              id: 'msg-user',
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['Hello'] },
              create_time: 1700000050.0,
              metadata: {},
            },
            parent: 'node-root',
            children: ['node-assistant-v1', 'node-assistant-v2'],
          },
          'node-assistant-v1': {
            id: 'node-assistant-v1',
            message: {
              id: 'msg-assistant-v1',
              author: { role: 'assistant' },
              content: { content_type: 'text', parts: ['Old response'] },
              create_time: 1700000100.0,
              metadata: {},
            },
            parent: 'node-user',
            children: [],
          },
          'node-assistant-v2': {
            id: 'node-assistant-v2',
            message: {
              id: 'msg-assistant-v2',
              author: { role: 'assistant' },
              content: { content_type: 'text', parts: ['Regenerated response'] },
              create_time: 1700000200.0,
              metadata: {},
            },
            parent: 'node-user',
            children: [],
          },
        },
      },
    ]);

    const result = parser.parse(raw);
    expect(result[0].messages).toHaveLength(2);
    expect(result[0].messages[1].content).toBe('Regenerated response');
  });

  it('extracts attachments from multimodal_text content', () => {
    const raw = JSON.stringify([
      {
        id: 'conv-4',
        create_time: 1700000000.0,
        update_time: 1700000100.0,
        current_node: 'node-assistant',
        mapping: {
          'node-root': {
            id: 'node-root',
            message: null,
            parent: null,
            children: ['node-user'],
          },
          'node-user': {
            id: 'node-user',
            message: {
              id: 'msg-user',
              author: { role: 'user' },
              content: {
                content_type: 'multimodal_text',
                parts: [
                  {
                    asset_pointer: 'sediment://file_abc123',
                    content_type: 'image_asset_pointer',
                    height: 1024,
                    width: 768,
                    size_bytes: 50000,
                  },
                  'What is in this image?',
                ],
              },
              create_time: 1700000050.0,
              metadata: {
                attachments: [
                  {
                    id: 'file_abc123',
                    name: 'photo.jpg',
                    mime_type: 'image/jpeg',
                    size: 50000,
                  },
                ],
              },
            },
            parent: 'node-root',
            children: ['node-assistant'],
          },
          'node-assistant': {
            id: 'node-assistant',
            message: {
              id: 'msg-assistant',
              author: { role: 'assistant' },
              content: { content_type: 'text', parts: ['It shows a landscape.'] },
              create_time: 1700000100.0,
              metadata: {},
            },
            parent: 'node-user',
            children: [],
          },
        },
      },
    ]);

    const result = parser.parse(raw);
    const userMsg = result[0].messages[0];
    expect(userMsg.content).toBe('What is in this image?');
    expect(userMsg.attachments).toHaveLength(1);
    expect(userMsg.attachments![0].storedName).toBe('file_abc123.dat');
    expect(userMsg.attachments![0].displayName).toBe('photo.jpg');
  });

  it('skips conversations without id', () => {
    const raw = JSON.stringify([
      {
        title: 'No ID conversation',
        create_time: 1700000000.0,
        update_time: 1700000100.0,
        current_node: 'node-user',
        mapping: {
          'node-root': {
            id: 'node-root',
            message: null,
            parent: null,
            children: ['node-user'],
          },
          'node-user': {
            id: 'node-user',
            message: {
              id: 'msg-user',
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['Hello'] },
              create_time: 1700000050.0,
              metadata: {},
            },
            parent: 'node-root',
            children: [],
          },
        },
      },
    ]);

    expect(parser.parse(raw)).toEqual([]);
  });

  it('converts Unix epoch timestamps to ISO strings', () => {
    const raw = JSON.stringify([
      {
        id: 'conv-5',
        create_time: 1700000000.0,
        update_time: 1700000100.0,
        current_node: 'node-user',
        mapping: {
          'node-root': {
            id: 'node-root',
            message: null,
            parent: null,
            children: ['node-user'],
          },
          'node-user': {
            id: 'node-user',
            message: {
              id: 'msg-user',
              author: { role: 'user' },
              content: { content_type: 'text', parts: ['Hi'] },
              create_time: 1700000050.0,
              metadata: {},
            },
            parent: 'node-root',
            children: [],
          },
        },
      },
    ]);

    const result = parser.parse(raw);
    expect(result[0].createdAt).toBe(new Date(1700000000 * 1000).toISOString());
    expect(result[0].updatedAt).toBe(new Date(1700000100 * 1000).toISOString());
  });
});