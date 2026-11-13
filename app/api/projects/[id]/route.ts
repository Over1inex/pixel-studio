import { account, json, ownedProject, safely, storage } from "../../_shared";
import { AppError, checkSameOrigin, readPayload, validProjectId } from "../../../../lib/project-validation.mjs";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };

async function projectId(context: Context) {
  const { id } = await context.params;
  if (!validProjectId(id)) throw new AppError("Проект не найден.", 404);
  return id;
}

export async function GET(_request: Request, context: Context) {
  return safely(async () => {
    const user = await account();
    const id = await projectId(context);
    const { db, bucket } = storage();
    const row = await ownedProject(db, id, user.userId);
    const object = await bucket.get(row.object_key);
    if (!object) throw new AppError("Файл проекта временно недоступен. Повторите попытку.", 503);
    return json({ id, name: row.name, document: await object.json(), updatedAt: row.updated_at });
  });
}

export async function PUT(request: Request, context: Context) {
  return safely(async () => {
    const user = await account();
    checkSameOrigin(request);
    const id = await projectId(context);
    const { db, bucket } = storage();
    const row = await ownedProject(db, id, user.userId);
    const { name, document } = await readPayload(request);
    const objectKey = `projects/${id}/${crypto.randomUUID()}.json`;
    const updatedAt = new Date().toISOString();
    const data = JSON.stringify(document);
    await bucket.put(objectKey, data, { httpMetadata: { contentType: "application/json" } });
    try {
      const result = await db.prepare("UPDATE projects SET name = ?, width = ?, height = ?, object_key = ?, byte_size = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND object_key = ?")
        .bind(name, document.width, document.height, objectKey, new TextEncoder().encode(data).length, updatedAt, id, user.userId, row.object_key).run();
      if (!result.meta.changes) throw new AppError("Проект изменился в другом окне. Откройте его заново или сохраните копию.", 409);
    } catch (error) {
      await bucket.delete(objectKey).catch(() => {});
      throw error;
    }
    await bucket.delete(row.object_key).catch(() => {});
    return json({ id, updatedAt });
  });
}

export async function DELETE(request: Request, context: Context) {
  return safely(async () => {
    const user = await account();
    checkSameOrigin(request);
    const id = await projectId(context);
    const { db, bucket } = storage();
    const row = await ownedProject(db, id, user.userId);
    const result = await db.prepare("DELETE FROM projects WHERE id = ? AND owner_id = ? AND object_key = ?")
      .bind(id, user.userId, row.object_key).run();
    if (!result.meta.changes) throw new AppError("Проект изменился в другом окне. Обновите список и повторите удаление.", 409);
    await bucket.delete(row.object_key).catch(() => {});
    return json({ deleted: true });
  });
}
