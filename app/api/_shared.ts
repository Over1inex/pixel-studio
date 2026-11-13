import { env } from "cloudflare:workers";
import { currentAccount } from "../account";
import { AppError } from "../../lib/project-validation.mjs";

export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function account() {
  const user = await currentAccount();
  if (!user) throw new AppError("Войдите в аккаунт, чтобы работать с облачными проектами.", 401);
  return user;
}

export function storage() {
  const db = env.DB;
  const bucket = env.BUCKET;
  if (!db || !bucket) throw new AppError("Облачное хранилище пока недоступно. Сохраните проект на компьютер.", 503);
  return { db, bucket };
}

export async function safely(action: () => Promise<Response>) {
  try { return await action(); }
  catch (error) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    console.error("Project operation failed", error instanceof Error ? error.message : "Unknown error");
    return json({ error: "Не удалось выполнить действие. Попробуйте снова или сохраните проект на компьютер." }, 500);
  }
}

export type ProjectRow = {
  id: string;
  name: string;
  width: number;
  height: number;
  object_key: string;
  updated_at: string;
};

export async function ownedProject(db: D1Database, id: string, ownerId: string) {
  const row = await db.prepare("SELECT id, name, width, height, object_key, updated_at FROM projects WHERE id = ? AND owner_id = ?")
    .bind(id, ownerId).first<ProjectRow>();
  if (!row) throw new AppError("Проект не найден.", 404);
  return row;
}
