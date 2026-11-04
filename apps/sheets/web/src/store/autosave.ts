// Local autosave: the workbook as XLSX bytes in IndexedDB, written a moment after the last edit.
// One saved workbook per browser for now; the collaboration server replaces this in phase 4.

export interface SavedBook {
  title: string;
  bytes: Uint8Array;
  savedAt: number;
}

const DB = "spectral-sheets";
const STORE = "books";
const KEY = "current";

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        t.oncomplete = () => {
          d.close();
          resolve(req.result);
        };
        t.onerror = () => {
          d.close();
          reject(t.error);
        };
      }),
  );
}

export const storage = {
  load: () => tx<SavedBook | undefined>("readonly", (s) => s.get(KEY)),
  save: (book: SavedBook) => tx("readwrite", (s) => s.put(book, KEY)).then(() => undefined),
  clear: () => tx("readwrite", (s) => s.delete(KEY)).then(() => undefined),
};

/** Runs `task` once `delay` ms after the last `schedule()`, never two at a time. */
export class Debounced {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private task: () => Promise<void>,
    private delay: number,
  ) {}

  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.fire(), this.delay);
  }

  /** Runs now (skipping the wait) and resolves when every pending run has finished. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      await this.fire();
    }
    while (this.running) await this.running;
  }

  private async fire(): Promise<void> {
    this.timer = null;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.task().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.fire();
      }
    });
    await this.running;
  }
}
