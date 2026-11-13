declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    GOOGLE_DESKTOP_CLIENT_ID?: string;
    GOOGLE_DESKTOP_CLIENT_SECRET?: string;
    GOOGLE_ALLOWED_EMAIL?: string;
  }
}
