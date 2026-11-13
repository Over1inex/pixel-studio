// Re-evaluate the current access policy on every request, including old sessions.
export function googleSessionAllowed(session, clientId, allowedEmail) {
  if (!clientId || !session || typeof session.user_id !== 'string' ||
      !session.user_id.startsWith('google:') || typeof session.email !== 'string' ||
      !session.email.trim()) return false;
  const allowed = typeof allowedEmail === 'string' ? allowedEmail.trim().toLowerCase() : '';
  return !allowed || session.email.trim().toLowerCase() === allowed;
}
