import type { Currency, Entitlements } from '@tessera/validation';

/** Display helpers for plans and invoices. */

export function money(amountMinor: number, currency: Currency): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(
    amountMinor / 100,
  );
}

export function bytes(value: number): string {
  const gib = value / 1024 ** 3;
  return gib >= 1
    ? `${String(Math.round(gib * 10) / 10)} GB`
    : `${String(Math.round(value / 1024 ** 2))} MB`;
}

export const TIER_NAMES: Record<Entitlements['tier'], string> = {
  free: 'Free',
  premium: 'Premium',
  creator: 'Creator',
  business: 'Business',
};

/** What a tier's limits mean, in words. */
export function describeLimits(limits: Entitlements['limits']): string[] {
  return [
    `Files up to ${bytes(limits['media.max_file_bytes'])} each`,
    `Up to ${bytes(limits['media.daily_bytes'])} of uploads a day (${String(limits['media.daily_uploads'])} files)`,
    `Own up to ${String(limits['channels.max_owned'])} channels`,
    `Schedule channel posts up to ${String(limits['channels.schedule_days'])} days ahead`,
  ];
}

const REGIONS =
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(
    ' ',
  );

/** ISO 3166-1 countries with their names in the person's language, India first. */
export function countries(): { code: string; name: string }[] {
  const names = new Intl.DisplayNames(undefined, { type: 'region' });
  const all = REGIONS.map((code) => ({ code, name: names.of(code) ?? code })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return [...all.filter((c) => c.code === 'IN'), ...all.filter((c) => c.code !== 'IN')];
}
