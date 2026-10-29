declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    READER_TOKEN?: string;
    RAINDROP_TOKEN?: string;
  }
}
