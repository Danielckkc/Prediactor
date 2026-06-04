import { createWriteStream } from "node:fs";

export class CrawlOutputWriter {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.format = options.format || "json";
    this._count = 0;
    this._buffer = filePath ? null : [];
    this._stream = null;
  }

  async open() {
    if (!this.filePath) return;
    this._stream = createWriteStream(this.filePath, { encoding: "utf8" });
    if (this.format === "json") {
      this._stream.write("[\n");
    }
  }

  async write(entry) {
    if (this._buffer) {
      this._buffer.push(entry);
      this._count++;
      return;
    }
    if (this.format === "jsonl") {
      this._stream.write(JSON.stringify(entry) + "\n");
    } else {
      const prefix = this._count > 0 ? ",\n" : "";
      this._stream.write(prefix + "  " + JSON.stringify(entry));
    }
    this._count++;
  }

  async close() {
    if (this._buffer) return this._buffer;
    if (this._stream) {
      if (this.format === "json") {
        this._stream.write("\n]\n");
      }
      await new Promise((resolve, reject) => {
        this._stream.on("error", reject);
        this._stream.end(() => resolve());
      });
      this._stream = null;
    }
  }

  get count() {
    return this._count;
  }
}
