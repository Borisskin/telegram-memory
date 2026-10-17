import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

export type FileType = 'document' | 'image' | 'audio' | 'video';

// The one list of extensions OpenViking parses (see docs/vendors.md).
const formats = JSON.parse(readFileSync(new URL('../config/openviking-formats.json', import.meta.url), 'utf8')) as Record<FileType, string[]>;

export function openVikingFileType(name: string): FileType | null {
  const extension = extname(name).toLowerCase();
  return (['document', 'image', 'audio', 'video'] as const).find((type) => formats[type].includes(extension)) ?? null;
}
