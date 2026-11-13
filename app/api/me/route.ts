import { currentAccount } from "../../account";
import { json, safely } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET() {
  return safely(async () => {
    const user = await currentAccount();
    return json({ user: user ? { id: user.userId, name: user.displayName, email: user.email } : null });
  });
}
