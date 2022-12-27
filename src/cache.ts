import { DB } from "./deps.ts";

export class Cache {
  private db: DB;

  constructor() {
    this.db = new DB("cache.db");
    this.db.query(`
      CREATE TABLE IF NOT EXISTS fetch (
        url TEXT PRIMARY KEY NOT NULL,
        body TEXT NOT NULL
      )
    `);
  }

  getBody(url: string): string | null {
    const result = this.db.query<[string]>(
      "SELECT body FROM fetch WHERE url = ?",
      [url],
    );

    for (const [body] of result) {
      return body;
    }

    return null;
  }

  saveBody(url: string, body: string) {
    this.db.query("INSERT OR REPLACE INTO fetch VALUES (?, ?)", [
      url,
      body,
    ]);
  }
}
