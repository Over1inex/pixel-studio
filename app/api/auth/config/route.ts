import {env} from 'cloudflare:workers';
import {json} from '../../_shared';
export const dynamic='force-dynamic';
export function GET(){return json({googleClientId:env.GOOGLE_DESKTOP_CLIENT_ID||null,provider:env.GOOGLE_DESKTOP_CLIENT_ID?'google':'chatgpt',animationProjects:2});}
