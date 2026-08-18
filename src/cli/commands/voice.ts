import { type Args, type CommandSpec } from '../args.js';
import { api, seg } from '../api.js';
import { fatal } from '../errors.js';
import { out } from '../output.js';
import type { Handler } from '../types.js';

export const voiceSpecs = {
  'voice numbers list': {
    usage: 'Usage: mindstudio-prod voice numbers list',
  },
  'voice numbers search': {
    usage:
      'Usage: mindstudio-prod voice numbers search --area-code <3 digits> [--locality <city>] [--state <region>] [--limit 10]',
    flags: {
      'area-code': { type: 'string' },
      locality: { type: 'string' },
      state: { type: 'string' },
      limit: { type: 'number', min: 1, max: 50 },
    },
    requireAnyOf: {
      flags: ['area-code', 'locality'],
      message: 'Provide --area-code or --locality to search.',
    },
  },
  'voice numbers buy': {
    usage:
      'Usage: mindstudio-prod voice numbers buy <e164> [--locality <city>] [--state <region>] [--monthly-cost <carrier cost>]\n' +
      'A dedicated number bills the workspace $2/month starting immediately. Only run this after the user has explicitly confirmed the purchase.',
    positionals: [{ name: 'e164', required: true }],
    flags: {
      locality: { type: 'string' },
      state: { type: 'string' },
      'monthly-cost': { type: 'string' },
    },
  },
  'voice numbers release': {
    usage:
      'Usage: mindstudio-prod voice numbers release <e164>\n' +
      'Releasing is permanent: no refund for the current month, the carrier quarantines the number ~15 days, and both inbound calls and deployed voice.call() stop working until a new number is attached.',
    positionals: [{ name: 'e164', required: true }],
  },
  'voice sessions list': {
    usage:
      'Usage: mindstudio-prod voice sessions list [--limit 20] [--cursor <nextCursor>]',
    flags: {
      limit: { type: 'number', param: 'limit', min: 1, max: 100 },
      cursor: { type: 'string', param: 'cursor' },
    },
  },
  'voice sessions get': {
    usage: 'Usage: mindstudio-prod voice sessions get <sessionId>',
    positionals: [{ name: 'sessionId', required: true }],
  },
  'voice settings get': {
    usage: 'Usage: mindstudio-prod voice settings get',
  },
  'voice settings set': {
    usage:
      'Usage: mindstudio-prod voice settings set [--max-concurrent-sessions <n>] [--max-per-visitor <n>] [--max-duration-secs <n>]',
    flags: {
      'max-concurrent-sessions': { type: 'number', min: 1 },
      'max-per-visitor': { type: 'number', min: 1 },
      'max-duration-secs': { type: 'number', min: 1 },
    },
    requireAnyOf: {
      flags: [
        'max-concurrent-sessions',
        'max-per-visitor',
        'max-duration-secs',
      ],
      message: 'Provide at least one setting to change.',
    },
  },
} satisfies Record<string, CommandSpec>;

// Resolve a phone-number row id from its E.164, so the agent never handles
// row UUIDs (the domains custom findHostnameId pattern).
async function findNumberId(appId: string, e164: string): Promise<string> {
  const res = await api(
    'GET',
    `/_internal/v2/apps/${appId}/settings/voice-phone-numbers`,
  );
  const entry = (res.numbers ?? []).find((n: any) => n.e164 === e164);
  if (!entry) {
    fatal(`No phone number "${e164}" on this app`);
  }
  return entry.id;
}

async function numbersList(appId: string) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/settings/voice-phone-numbers`,
    ),
  );
}
async function numbersSearch(appId: string, a: Args) {
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/settings/voice-phone-numbers/search`,
      {
        areaCode: a.str('area-code'),
        locality: a.str('locality'),
        administrativeArea: a.str('state'),
        limit: a.num('limit'),
      },
    ),
  );
}
async function numbersBuy(appId: string, a: Args) {
  // The optional flags echo the chosen search result's display snapshot —
  // they label the number in the dashboard, nothing more.
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/settings/voice-phone-numbers`,
      {
        phoneNumber: a.req('e164'),
        locality: a.str('locality'),
        administrativeArea: a.str('state'),
        monthlyCost: a.str('monthly-cost'),
      },
    ),
  );
}
async function numbersRelease(appId: string, a: Args) {
  const id = await findNumberId(appId, a.req('e164'));
  out(
    await api(
      'POST',
      `/_internal/v2/apps/${appId}/settings/voice-phone-numbers/${seg(id)}/release`,
    ),
  );
}
async function sessionsList(appId: string, a: Args) {
  out(
    await api('GET', `/_internal/v2/apps/${appId}/voice-sessions${a.query()}`),
  );
}
async function sessionsGet(appId: string, a: Args) {
  out(
    await api(
      'GET',
      `/_internal/v2/apps/${appId}/voice-sessions/${seg(a.req('sessionId'))}`,
    ),
  );
}
async function settingsGet(appId: string) {
  out(await api('GET', `/_internal/v2/apps/${appId}/voice-settings`));
}
async function settingsSet(appId: string, a: Args) {
  out(
    await api('PUT', `/_internal/v2/apps/${appId}/voice-settings`, {
      maxConcurrentSessions: a.num('max-concurrent-sessions'),
      maxConcurrentSessionsPerVisitor: a.num('max-per-visitor'),
      maxSessionDurationSecs: a.num('max-duration-secs'),
    }),
  );
}

export const voiceHandlers = {
  'voice numbers list': numbersList,
  'voice numbers search': numbersSearch,
  'voice numbers buy': numbersBuy,
  'voice numbers release': numbersRelease,
  'voice sessions list': sessionsList,
  'voice sessions get': sessionsGet,
  'voice settings get': settingsGet,
  'voice settings set': settingsSet,
} satisfies Record<keyof typeof voiceSpecs, Handler>;

export const voiceHelp = `mindstudio-prod voice — Phone numbers, call log, and voice policy settings.

Subcommands:
  numbers list      The app's dedicated phone number(s) and their status
  numbers search    Search available US numbers by area code / locality
  numbers buy       Buy + attach a dedicated number ($2/month — confirm with the user first)
  numbers release   Release the number (permanent, no refund, ~15-day carrier quarantine)
  sessions list     Call log (web, phone-out, phone-in), newest first
  sessions get      One session with full transcript and cost breakdown
  settings get      Voice policy (concurrency, per-visitor, max duration) + ceilings
  settings set      Override voice policy (clamped to platform ceilings)

Usage:
  mindstudio-prod voice numbers search --area-code 310 [--locality <city>] [--state <region>] [--limit 10]
  mindstudio-prod voice numbers buy <e164> [--locality <city>] [--state <region>] [--monthly-cost <carrier cost>]
  mindstudio-prod voice numbers release <e164>
  mindstudio-prod voice sessions list [--limit 20] [--cursor <nextCursor>]
  mindstudio-prod voice sessions get <sessionId>
  mindstudio-prod voice settings set [--max-concurrent-sessions <n>] [--max-per-visitor <n>] [--max-duration-secs <n>]

Examples:
  mindstudio-prod voice numbers search --area-code 310 --limit 5
  mindstudio-prod voice numbers buy +13105551234 --locality "Los Angeles" --state CA --monthly-cost 1.00000
  mindstudio-prod voice sessions list --limit 10
  mindstudio-prod voice sessions get 4f6c…

Notes:
  Buying a number starts a recurring $2/month workspace charge — never run
  'numbers buy' without the user's explicit confirmation. The dedicated number
  is both the outbound caller ID for voice.call() and the app's inbound line
  (inbound calls answer the LIVE release's voice agent). A 'pending' number
  usually activates within seconds — poll 'numbers list'. Transcripts
  ('sessions get') are the primary way to debug and iterate on a voice persona.`;
