import type { FastifyReply } from 'fastify';
import type { Config } from '../config.js';

export const cookieName = (config: Config) =>
  config.NODE_ENV === 'production' ? '__Host-qa_session' : 'qa_session';
const attributes = (config: Config) => ({
  httpOnly: true,
  secure: config.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
});
export function setSessionCookie(
  reply: FastifyReply,
  config: Config,
  token: string,
  expiresAt: Date,
) {
  reply.setCookie(cookieName(config), token, {
    ...attributes(config),
    expires: expiresAt,
    maxAge: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  });
}
export function clearSessionCookie(reply: FastifyReply, config: Config) {
  reply.clearCookie(cookieName(config), attributes(config));
}
