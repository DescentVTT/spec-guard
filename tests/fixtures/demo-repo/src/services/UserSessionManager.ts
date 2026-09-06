/** The single owner of session state. */
export class UserSessionManager {
  private readonly sessions = new Map<string, string>();

  open(userId: string): string {
    const token = 'session-' + userId;
    this.sessions.set(userId, token);
    return token;
  }
}
