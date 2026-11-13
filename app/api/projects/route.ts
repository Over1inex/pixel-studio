import { account, json, safely, storage } from "../_shared";
import { AppError, checkSameOrigin, MAX_PROJECTS, readPayload } from "../../../lib/project-validation.mjs";

export const dynamic = "force-dynamic";

export async function GET() {
  return safely(async () => {
    const user = await account();
    const { db } = storage();
    const result = await db.prepare("SELECT id, name, width, height, updated_at AS updatedAt FROM projects WHERE owner_id = ? ORDER BY updated_at DESC LIMIT ?")
      .bind(user.userId, MAX_PROJECTS).all();
    return json({ projects: result.results });
  });
}

export async function POST(request: Request) {
  return safely(async () => {
    const user = await account();
    checkSameOrigin(request);
    const { name, document } = await readPayload(request);
    const { db, bucket } = storage();
    const id = crypto.randomUUID();
    const objectKey = `projects/${id}/${crypto.randomUUID()}.json`;
    const updatedAt = new Date().toISOString();
    const data = JSON.stringify(document);
    await bucket.put(objectKey, data, { httpMetadata: { contentType: "application/json" } });
    try {
      const result = await db.prepare("INSERT INTO projects (id, owner_id, name, width, height, object_key, byte_size, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM projects WHERE owner_id = ?) < ?")
        .bind(id, user.userId, name, document.width, document.height, objectKey, new TextEncoder().encode(data).length, updatedAt, updatedAt, user.userId, MAX_PROJECTS).run();
      if (!result.meta.changes) throw new AppError("Достигнут лимит: 30 облачных проектов. Удалите ненужный проект.", 409);
    } catch (error) {
      await bucket.delete(objectKey).catch(() => {});
      throw error;
    }
    return json({ id, updatedAt }, 201);
  });
}
