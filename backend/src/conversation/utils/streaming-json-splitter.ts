import * as fs from 'node:fs';

export class StreamingJsonArraySplitter {
  private depth = 0;
  private inString = false;
  private escape = false;
  private itemStart = -1;
  private buffer = '';

  feed(chunk: string): string[] {
    const results: string[] = [];
    const offset = this.buffer.length;
    this.buffer += chunk;

    for (let i = offset; i < this.buffer.length; i++) {
      const ch = this.buffer[i];

      if (this.escape) {
        this.escape = false;
        continue;
      }

      if (this.inString) {
        if (ch === '\\') this.escape = true;
        else if (ch === '"') this.inString = false;
        continue;
      }

      if (ch === '"') {
        this.inString = true;
        continue;
      }

      if (ch === '{' || ch === '[') {
        if (this.depth === 1 && this.itemStart < 0) {
          this.itemStart = i;
        }
        this.depth++;
        continue;
      }

      if (ch === '}' || ch === ']') {
        this.depth--;
        if (this.depth === 1 && this.itemStart >= 0) {
          results.push(this.buffer.substring(this.itemStart, i + 1));
          this.itemStart = -1;
        }
        continue;
      }
    }

    if (this.itemStart < 0) {
      this.buffer = '';
    } else if (this.itemStart > 0) {
      this.buffer = this.buffer.substring(this.itemStart);
      this.itemStart = 0;
    }

    return results;
  }

  finish(): string[] {
    if (this.itemStart >= 0 && this.depth >= 2) {
      const item = this.buffer.substring(this.itemStart);
      this.reset();
      return [item];
    }
    this.reset();
    return [];
  }

  private reset(): void {
    this.depth = 0;
    this.inString = false;
    this.escape = false;
    this.itemStart = -1;
    this.buffer = '';
  }
}

export async function* splitJsonArrayFile(
  filePath: string,
  highWaterMark = 64 * 1024,
): AsyncGenerator<string> {
  const splitter = new StreamingJsonArraySplitter();
  const stream = fs.createReadStream(filePath, {
    encoding: 'utf-8',
    highWaterMark,
  });

  for await (const chunk of stream) {
    for (const item of splitter.feed(chunk as string)) {
      yield item;
    }
  }

  for (const item of splitter.finish()) {
    yield item;
  }
}
