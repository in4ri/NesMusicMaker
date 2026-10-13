// File access: uses the Electron bridge when available, otherwise browser download/upload.

export interface NesApi {
  openProject(): Promise<{ path: string; text: string } | null>;
  saveProject(path: string | null, text: string): Promise<string | null>;
  saveBinary(defaultName: string, filterName: string, extensions: string[], bytes: Uint8Array): Promise<string | null>;
  setTitle(title: string): void;
  loadLibrary(): Promise<string | null>;
  saveLibrary(text: string): Promise<boolean>;
  onMenu(cb: (command: string | { open: { path: string; text: string } }) => void): () => void;
}

declare global {
  interface Window {
    nesApi?: NesApi;
  }
}

export const isElectron = () => !!window.nesApi;

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Show a file picker and return the chosen file (browser and Electron). */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function openProjectFile(): Promise<{ path: string | null; text: string } | null> {
  if (window.nesApi) return window.nesApi.openProject();
  const file = await pickFile('.nesmm,.json');
  return file ? { path: null, text: await file.text() } : null;
}

/** Returns the saved path (Electron), '' for a browser download, or null if cancelled. */
export async function saveProjectFile(path: string | null, text: string, suggestedName: string): Promise<string | null> {
  if (window.nesApi) return window.nesApi.saveProject(path, text);
  download(suggestedName, text, 'application/json');
  return '';
}

export async function saveBinaryFile(name: string, filterName: string, ext: string, bytes: Uint8Array): Promise<string | null> {
  if (window.nesApi) return window.nesApi.saveBinary(name, filterName, [ext], bytes);
  download(name, bytes as BlobPart, 'application/octet-stream');
  return '';
}

const LIBRARY_KEY = 'nes-music-maker.preset-library';

/** Read the preset library (Electron: the app's settings folder; browser: local storage). */
export async function loadLibraryText(): Promise<string | null> {
  if (window.nesApi) return window.nesApi.loadLibrary();
  try {
    return localStorage.getItem(LIBRARY_KEY);
  } catch {
    return null;
  }
}

export async function saveLibraryText(text: string): Promise<boolean> {
  if (window.nesApi) return window.nesApi.saveLibrary(text);
  try {
    localStorage.setItem(LIBRARY_KEY, text);
    return true;
  } catch {
    return false;
  }
}
