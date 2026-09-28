import { activeCodec } from './messaging/codec.js';

/** Where signed-in users land: chats when this build supports messaging. */
export const HOME_PATH = activeCodec === null ? '/settings/security' : '/chats';
