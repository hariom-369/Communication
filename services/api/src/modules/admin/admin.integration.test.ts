import { newId } from '@tessera/shared';
import { ADMIN_ROLES, type AdminRole } from '@tessera/validation';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildAdminApp } from '../../admin-app.js';
import {
  AdminTestClient,
  makeAdmin,
  startAdminApp,
  type AdminTestEnv,
  type TestAdmin,
} from '../../test/admin-app.js';
import {
  TestClient,
  createActiveUser,
  startIntegrationApp,
  type IntegrationApp,
} from '../../test/integration-app.js';
import { InProcessRateLimiter } from '../../platform/rate-limit.js';
import { rolloutBucket } from '../flags/index.js';

/**
 * The admin console's API (docs/admin.md §2–§4, ADR-050). Exit criteria for Phase 12: the
 * **authorization matrix** (every admin route × every role, deny by default) and **audit
 * completeness** (every call — allowed, refused or invalid — leaves an audit entry before the
 * response). Then purpose binding, just-in-time elevation and four-eyes approvals, feature
 * flags, aggregates with small-count suppression, health, and the audit viewer.
 */

let env: IntegrationApp;
let admin: AdminTestEnv;

beforeAll(async () => {
  env = await startIntegrationApp();
  admin = await startAdminApp(env);
});
afterAll(async () => {
  await admin.close();
  await env.close();
});

const code = (response: LightMyRequestResponse) => response.json<{ code: string }>().code;
const ALL = ADMIN_ROLES;

async function person() {
  const created = await createActiveUser(env);
  const me = (await created.client.get('/api/v1/accounts/me')).json<{ id: string }>();
  return { ...created, id: me.id };
}

async function auditFor(requestIds: string[]) {
  return env.db
    .selectFrom('audit_log')
    .select(['request_id', 'actor_kind', 'actor_id', 'action', 'target_id', 'details'])
    .where('request_id', 'in', requestIds)
    .execute();
}

// ---- the authorization matrix ---------------------------------------------------------------

/**
 * Who may call what (docs/admin.md §2). Written out here rather than derived from the code, so a
 * change to a route's capability fails this test until the table — and the doc — change too.
 */
const MATRIX: Record<string, readonly AdminRole[]> = {
  'admin.me': ALL,
  'admin.reauth_options': ALL,
  'admin.reauth_verify': ALL,
  'admin.logout': ALL,
  // Sign-in steps: a signed-in session is past them.
  'admin.key_options': [],
  'admin.key_verify': [],
  'admin.dashboard': ALL,
  'admin.signups': ['super_admin', 'analyst'],
  'admin.health': ['super_admin', 'security_admin', 'analyst'],
  'admin.security_hotspots': ['super_admin', 'security_admin'],
  'admin.user_lookup': ['super_admin', 'security_admin', 'moderator', 'support_agent'],
  'admin.user_detail': ['super_admin', 'security_admin', 'moderator', 'support_agent'],
  'admin.user_revoke_sessions': ['super_admin', 'security_admin', 'support_agent'],
  'admin.user_resend_verification': ['super_admin', 'support_agent'],
  'admin.ticket_create': ['super_admin', 'support_agent'],
  'admin.tickets': ['super_admin', 'support_agent'],
  'admin.ticket_close': ['super_admin', 'support_agent'],
  'admin.approvals': ALL,
  'admin.approval_request': ALL,
  'admin.approval_approve': ALL,
  'admin.approval_reject': ALL,
  'admin.approval_cancel': ALL,
  'admin.admins': ['super_admin', 'security_admin'],
  'admin.admin_disable': ['super_admin', 'security_admin'],
  'admin.staff': ['super_admin', 'security_admin'],
  'admin.staff_revoke': ['super_admin', 'security_admin'],
  'admin.flags': ['super_admin', 'security_admin'],
  'admin.audit': ALL,
};
/** Before sign-in; covered by the sign-in tests. */
const PUBLIC = ['admin.oidc_start', 'admin.oidc_callback'];

/**
 * One request per route. Bodies are deliberately not valid where a valid one would change
 * state: authorization runs before validation, so a denied role sees 403 and an allowed one gets
 * past it (to 400, 404 or 200).
 */
function probe(
  routeId: string,
  subjectId: string,
): { method: 'GET' | 'POST'; url: string } & {
  body?: unknown;
} {
  const id = newId();
  const investigation = 'investigation:authorization matrix probe';
  const probes: Record<string, { method: 'GET' | 'POST'; url: string; body?: unknown }> = {
    'admin.me': { method: 'GET', url: '/admin/v1/me' },
    'admin.reauth_options': { method: 'POST', url: '/admin/v1/auth/reauth/options', body: {} },
    'admin.reauth_verify': { method: 'POST', url: '/admin/v1/auth/reauth/verify', body: {} },
    'admin.logout': { method: 'POST', url: '/admin/v1/auth/logout', body: {} },
    'admin.key_options': { method: 'POST', url: '/admin/v1/auth/key/options', body: {} },
    'admin.key_verify': { method: 'POST', url: '/admin/v1/auth/key/verify', body: {} },
    'admin.dashboard': { method: 'GET', url: '/admin/v1/dashboard' },
    'admin.signups': { method: 'GET', url: '/admin/v1/analytics/signups' },
    'admin.health': { method: 'GET', url: '/admin/v1/health' },
    'admin.security_hotspots': { method: 'GET', url: '/admin/v1/security/hotspots' },
    'admin.user_lookup': {
      method: 'POST',
      url: '/admin/v1/users/lookup',
      body: { identifier: subjectId, purpose: investigation },
    },
    'admin.user_detail': {
      method: 'GET',
      url: `/admin/v1/users/${subjectId}?purpose=${encodeURIComponent(investigation)}`,
    },
    'admin.user_revoke_sessions': {
      method: 'POST',
      url: `/admin/v1/users/${id}/sessions/revoke`,
      body: { purpose: investigation },
    },
    'admin.user_resend_verification': {
      method: 'POST',
      url: `/admin/v1/users/${subjectId}/resend-verification`,
      body: {},
    },
    'admin.ticket_create': { method: 'POST', url: '/admin/v1/tickets', body: {} },
    'admin.tickets': { method: 'GET', url: '/admin/v1/tickets' },
    'admin.ticket_close': { method: 'POST', url: `/admin/v1/tickets/${id}/close`, body: {} },
    'admin.approvals': { method: 'GET', url: '/admin/v1/approvals' },
    'admin.approval_request': { method: 'POST', url: '/admin/v1/approvals', body: {} },
    'admin.approval_approve': {
      method: 'POST',
      url: `/admin/v1/approvals/${id}/approve`,
      body: {},
    },
    'admin.approval_reject': { method: 'POST', url: `/admin/v1/approvals/${id}/reject`, body: {} },
    'admin.approval_cancel': { method: 'POST', url: `/admin/v1/approvals/${id}/cancel`, body: {} },
    'admin.admins': { method: 'GET', url: '/admin/v1/admins' },
    'admin.admin_disable': { method: 'POST', url: `/admin/v1/admins/${id}/disable`, body: {} },
    'admin.staff': { method: 'GET', url: '/admin/v1/staff-roles' },
    'admin.staff_revoke': { method: 'POST', url: '/admin/v1/staff-roles/revoke', body: {} },
    'admin.flags': { method: 'GET', url: '/admin/v1/flags' },
    'admin.audit': { method: 'GET', url: '/admin/v1/audit' },
  };
  const found = probes[routeId];
  if (found === undefined) throw new Error(`No probe for ${routeId}`);
  return found;
}

describe('authorization matrix and audit completeness', () => {
  it('the matrix covers every admin route', () => {
    const ids = admin.admin.routes.map((route) => route.id).sort();
    expect([...Object.keys(MATRIX), ...PUBLIC].sort()).toEqual(ids);
  });

  it('every route × every role: allowed exactly as the table says, every call audited', async () => {
    const subject = await person();
    const results: { routeId: string; role: AdminRole; adminId: string; requestId: string }[] = [];
    for (const role of ADMIN_ROLES) {
      const staff = await makeAdmin(admin, [role]);
      // Sign-out last: it ends the session the other probes use.
      const order = Object.keys(MATRIX).sort((a, b) =>
        a === 'admin.logout' ? 1 : b === 'admin.logout' ? -1 : 0,
      );
      for (const routeId of order) {
        const { method, url, body } = probe(routeId, subject.id);
        const response = await staff.client.request(method, url, body);
        const allowed = (MATRIX[routeId] ?? []).includes(role);
        const denied = response.statusCode === 403 && code(response) === 'FORBIDDEN';
        expect(
          { routeId, role, status: response.statusCode, denied },
          `${routeId} as ${role}: ${response.body}`,
        ).toEqual({ routeId, role, status: response.statusCode, denied: !allowed });
        expect(response.statusCode).not.toBe(401);
        expect(response.statusCode).toBeLessThan(500);
        results.push({
          routeId,
          role,
          adminId: staff.id,
          requestId: String(response.headers['x-request-id']),
        });
      }
    }

    // Audit completeness: one entry per call, with who, what, and the outcome.
    const entries = await auditFor(results.map((r) => r.requestId));
    const byRequest = new Map(entries.map((entry) => [entry.request_id, entry]));
    for (const result of results) {
      const entry = byRequest.get(result.requestId);
      expect(entry, `${result.routeId} as ${result.role} was not audited`).toBeDefined();
      expect(entry).toMatchObject({
        actor_kind: 'admin',
        actor_id: result.adminId,
        action: result.routeId,
      });
      const details = entry?.details as { outcome: string; roles: string; ip: string };
      expect(details.roles).toBe(result.role);
      expect(details.ip).toMatch(/^ip:203\.0\.113\.\d+$/);
      expect(details.outcome).toMatch(/^(ok|[A-Z_]+)$/);
      if (!(MATRIX[result.routeId] ?? []).includes(result.role))
        expect(details.outcome).toBe('FORBIDDEN');
    }
    expect(entries).toHaveLength(results.length);
  });

  it('calls without a session are refused and audited too', async () => {
    const anonymous = new AdminTestClient(admin.app);
    const requestIds: string[] = [];
    for (const routeId of Object.keys(MATRIX)) {
      const { method, url, body } = probe(routeId, newId());
      const response = await anonymous.request(method, url, body);
      expect(response.statusCode, routeId).toBe(401);
      requestIds.push(String(response.headers['x-request-id']));
    }
    const entries = await auditFor(requestIds);
    expect(entries).toHaveLength(requestIds.length);
    for (const entry of entries) {
      expect(entry.actor_id).toBeNull();
      expect((entry.details as { outcome: string }).outcome).toBe('UNAUTHENTICATED');
    }
  });

  it('no audit, no answer: if the audit write fails the call fails', async () => {
    const staff = await makeAdmin(admin, ['analyst']);
    const broken = await buildAdminApp({
      logger: env.logger,
      rateLimiter: new InProcessRateLimiter(),
      allowedOrigins: ['https://admin.tessera.test'],
      trustProxyHops: 0,
      hsts: true,
      routes: admin.admin.routes,
      sessions: admin.admin.sessions,
      audit: { record: () => Promise.reject(new Error('audit store down')) },
    });
    try {
      const client = new AdminTestClient(broken);
      for (const [name, value] of staff.client.cookies) client.cookies.set(name, value);
      const response = await client.get('/admin/v1/dashboard');
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('users');
      expect(response.body).not.toContain('audit store down');
    } finally {
      await broken.close();
    }
  });
});

// ---- purpose binding ----------------------------------------------------------------------

describe('purpose binding', () => {
  let support: TestAdmin;
  let moderator: TestAdmin;
  let security: TestAdmin;
  let analyst: TestAdmin;

  beforeAll(async () => {
    support = await makeAdmin(admin, ['support_agent']);
    moderator = await makeAdmin(admin, ['moderator']);
    security = await makeAdmin(admin, ['security_admin']);
    analyst = await makeAdmin(admin, ['analyst']);
  });

  async function openCase(userId: string): Promise<string> {
    const id = newId();
    await env.db
      .insertInto('moderation_cases')
      .values({
        id,
        subject_kind: 'user',
        subject_id: userId,
        subject_user_id: userId,
        category: 'spam',
        source: 'report',
        priority: 3,
        status: 'open',
        ack_due_at: new Date(Date.now() + 3_600_000),
        due_at: new Date(Date.now() + 86_400_000),
      })
      .execute();
    return id;
  }

  it('support staff reach a person only through an open ticket about them', async () => {
    const alice = await person();
    const bob = await person();
    const lookup = (purpose: string, identifier = alice.username) =>
      support.client.post('/admin/v1/users/lookup', { identifier, purpose });

    expect((await lookup('investigation:just curious about this account')).statusCode).toBe(404);

    const ticket = await support.client.post('/admin/v1/tickets', {
      reference: 'HD-1001',
      identifier: alice.email,
      reason: 'Cannot sign in on a new phone',
    });
    expect(ticket.statusCode).toBe(201);
    const ticketId = ticket.json<{ id: string }>().id;
    const found = await lookup(`ticket:${ticketId}`);
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ id: alice.id, username: alice.username });

    // The same ticket does not open someone else's account.
    expect((await lookup(`ticket:${ticketId}`, bob.username)).statusCode).toBe(404);

    const detail = await support.client.get(
      `/admin/v1/users/${alice.id}?purpose=${encodeURIComponent(`ticket:${ticketId}`)}`,
    );
    expect(detail.statusCode).toBe(200);
    // Metadata only: no secrets, no content.
    for (const forbidden of ['password_hash', 'passwordHash', 'token', 'secret', 'ciphertext'])
      expect(detail.body).not.toContain(forbidden);
    expect(detail.json()).toMatchObject({
      credentials: { hasPassword: true },
      standing: { status: 'good' },
    });

    // The purpose is recorded with each look.
    const entries = await env.db
      .selectFrom('audit_log')
      .select(['action', 'details', 'target_id'])
      .where('actor_id', '=', support.id)
      .where('action', 'in', ['admin.user_lookup', 'admin.user_detail'])
      .where('target_id', '=', alice.id)
      .execute();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(
      entries.every((e) => (e.details as { purpose: string }).purpose.startsWith('ticket:')),
    ).toBe(true);

    // Once the ticket is closed, the purpose has ended.
    expect((await support.client.post(`/admin/v1/tickets/${ticketId}/close`)).statusCode).toBe(200);
    expect((await lookup(`ticket:${ticketId}`)).statusCode).toBe(404);
  });

  it('moderators through an open case about the person; security staff with a reason', async () => {
    const carol = await person();
    const dave = await person();
    const caseId = await openCase(carol.id);
    const viewAs = (staff: TestAdmin, userId: string, purpose: string) =>
      staff.client.get(`/admin/v1/users/${userId}?purpose=${encodeURIComponent(purpose)}`);

    expect((await viewAs(moderator, carol.id, `case:${caseId}`)).statusCode).toBe(200);
    expect((await viewAs(moderator, dave.id, `case:${caseId}`)).statusCode).toBe(404);
    expect(
      (await viewAs(moderator, carol.id, 'investigation:moderators cannot use this')).statusCode,
    ).toBe(404);
    // Support staff cannot borrow a moderation case.
    expect((await viewAs(support, carol.id, `case:${caseId}`)).statusCode).toBe(404);

    expect(
      (await viewAs(security, dave.id, 'investigation:credential stuffing from 198.51.100.0/24'))
        .statusCode,
    ).toBe(200);
    // A reason must be written out.
    expect((await viewAs(security, dave.id, 'investigation:short')).statusCode).toBe(400);
    // Analysts never see a person.
    expect((await viewAs(analyst, dave.id, `case:${caseId}`)).statusCode).toBe(403);

    // A resolved case is no longer a purpose.
    await env.db
      .updateTable('moderation_cases')
      .set({ status: 'dismissed' })
      .where('id', '=', caseId)
      .execute();
    expect((await viewAs(moderator, carol.id, `case:${caseId}`)).statusCode).toBe(404);
  });

  it('signs a person out for a purpose; verification email only while pending', async () => {
    const erin = await person();
    const ticket = (
      await support.client.post('/admin/v1/tickets', {
        reference: 'HD-1002',
        identifier: erin.username,
        reason: 'Lost phone, wants all sessions ended',
      })
    ).json<{ id: string }>();
    const purpose = `ticket:${ticket.id}`;
    const revoked = await support.client.post(`/admin/v1/users/${erin.id}/sessions/revoke`, {
      purpose,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json<{ revoked: number }>().revoked).toBeGreaterThanOrEqual(1);
    expect((await erin.client.get('/api/v1/accounts/me')).statusCode).toBe(401);

    const resend = await support.client.post(`/admin/v1/users/${erin.id}/resend-verification`, {
      purpose,
    });
    expect(resend.statusCode).toBe(409);
  });

  it('many lookups in a short time raise an alert', async () => {
    const frank = await person();
    const reason = 'investigation:bulk lookup alert check';
    for (let i = 0; i < 21; i += 1)
      await security.client.post('/admin/v1/users/lookup', {
        identifier: frank.username,
        purpose: reason,
      });
    expect(
      env.logs.records().some((r) => r['event'] === 'admin.alert' && r['check'] === 'bulk_lookups'),
    ).toBe(true);
  });
});

// ---- just-in-time elevation and four eyes ----------------------------------------------------

describe('four-eyes approvals and just-in-time elevation', () => {
  let superA: TestAdmin;
  let superB: TestAdmin;
  let security: TestAdmin;

  beforeAll(async () => {
    superA = await makeAdmin(admin, ['super_admin']);
    superB = await makeAdmin(admin, ['super_admin']);
    security = await makeAdmin(admin, ['security_admin']);
  });

  const request = (staff: TestAdmin, payload: Record<string, unknown>, reason = 'Needed today') =>
    staff.client.post('/admin/v1/approvals', { payload, reason });
  const approve = (staff: TestAdmin, id: string) =>
    staff.client.post(`/admin/v1/approvals/${id}/approve`, { note: 'ok' });

  it('an eligible admin elevates themselves for at most 8 hours, once another admin approves', async () => {
    const oncall = await makeAdmin(admin, ['analyst']);
    const ask = (hours: number, role = 'security_admin', adminId = oncall.id) =>
      request(oncall, { kind: 'role_grant', adminId, role, hours });

    // Not eligible yet.
    expect((await ask(4)).statusCode).toBe(403);
    const eligibility = await request(superA, {
      kind: 'eligibility',
      adminId: oncall.id,
      roles: ['security_admin'],
    });
    expect(eligibility.statusCode).toBe(201);
    expect((await approve(superB, eligibility.json<{ id: string }>().id)).statusCode).toBe(200);

    expect((await ask(9)).statusCode).toBe(403); // over the 8-hour cap
    expect((await ask(4, 'super_admin')).statusCode).toBe(403); // not eligible for that one
    expect((await ask(4, 'security_admin', superA.id)).statusCode).toBe(403); // only for yourself
    const asked = await ask(4);
    expect(asked.statusCode).toBe(201);
    const id = asked.json<{ id: string }>().id;

    // Nobody approves their own request, and the person it is about cannot approve it either.
    expect((await approve(oncall, id)).statusCode).toBe(403);
    expect(code(await approve(oncall, id))).toBe('FORBIDDEN');
    expect((await oncall.client.get('/admin/v1/security/hotspots')).statusCode).toBe(403);

    const approved = await approve(security, id);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'approved', decidedBy: security.id });
    expect((await oncall.client.get('/admin/v1/security/hotspots')).statusCode).toBe(200);
    const me = (await oncall.client.get('/admin/v1/me')).json<{
      roles: { role: string; expiresAt: string }[];
    }>();
    const elevated = me.roles.find((r) => r.role === 'security_admin');
    expect(new Date(elevated?.expiresAt ?? 0).getTime()).toBeLessThanOrEqual(
      Date.now() + 4 * 3_600_000 + 5_000,
    );
    const grant = await env.db
      .selectFrom('admin_role_grants')
      .select(['approval_id', 'granted_by'])
      .where('admin_id', '=', oncall.id)
      .where('role', '=', 'security_admin')
      .executeTakeFirstOrThrow();
    expect(grant.approval_id).toBe(id);
    expect(
      env.logs
        .records()
        .some((r) => r['event'] === 'admin.alert' && r['check'] === 'role_grant:security_admin'),
    ).toBe(true);
  });

  it('the database itself refuses a self-approval', async () => {
    const asked = await request(superA, {
      kind: 'admin_create',
      email: 'db-check@tessera.test',
      displayName: 'DB check',
    });
    const id = asked.json<{ id: string }>().id;
    await expect(
      env.db
        .updateTable('admin_approvals')
        .set({ status: 'approved', decided_by: superA.id })
        .where('id', '=', id)
        .execute(),
    ).rejects.toThrow(/check constraint/);
  });

  it('the person a role grant is for cannot approve it, even as a super admin', async () => {
    const asked = await request(superA, {
      kind: 'role_grant',
      adminId: superB.id,
      role: 'support_agent',
      hours: 24,
    });
    const id = asked.json<{ id: string }>().id;
    expect(code(await approve(superB, id))).toBe('FORBIDDEN');
    const superC = await makeAdmin(admin, ['super_admin']);
    expect((await approve(superC, id)).statusCode).toBe(200);
  });

  it('only one of two simultaneous approvals takes effect', async () => {
    const target = await makeAdmin(admin, ['analyst']);
    const superC = await makeAdmin(admin, ['super_admin']);
    const asked = await request(superA, {
      kind: 'role_grant',
      adminId: target.id,
      role: 'support_agent',
      hours: 24,
    });
    const id = asked.json<{ id: string }>().id;
    const [first, second] = await Promise.all([approve(superB, id), approve(superC, id)]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    const grants = await env.db
      .selectFrom('admin_role_grants')
      .select('id')
      .where('admin_id', '=', target.id)
      .where('role', '=', 'support_agent')
      .execute();
    expect(grants).toHaveLength(1);
  });

  it('requests expire after a day; requesters may withdraw; others may reject', async () => {
    const make = async () =>
      (
        await request(superA, {
          kind: 'admin_create',
          email: `new_${newId().slice(0, 8)}@tessera.test`,
          displayName: 'New staff',
        })
      ).json<{ id: string; expiresAt: string; requestedAt: string }>();

    const expired = await make();
    expect(
      new Date(expired.expiresAt).getTime() - new Date(expired.requestedAt).getTime(),
    ).toBeLessThanOrEqual(24 * 3_600_000 + 1_000);
    await env.db
      .updateTable('admin_approvals')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', expired.id)
      .execute();
    expect((await approve(superB, expired.id)).statusCode).toBe(409);

    const withdrawn = await make();
    expect(
      (await superB.client.post(`/admin/v1/approvals/${withdrawn.id}/cancel`)).statusCode,
    ).toBe(403);
    expect(
      (await superA.client.post(`/admin/v1/approvals/${withdrawn.id}/cancel`)).statusCode,
    ).toBe(200);
    expect((await approve(superB, withdrawn.id)).statusCode).toBe(409);

    const rejected = await make();
    expect(
      (await superA.client.post(`/admin/v1/approvals/${rejected.id}/reject`, { note: 'mine' }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await superB.client.post(`/admin/v1/approvals/${rejected.id}/reject`, {
          note: 'Not needed',
        })
      ).statusCode,
    ).toBe(200);
    const listed = (await superA.client.get('/admin/v1/approvals?status=rejected')).json<{
      approvals: { id: string; decisionNote: string }[];
    }>();
    expect(listed.approvals.find((a) => a.id === rejected.id)?.decisionNote).toBe('Not needed');
  });

  it('approving needs a fresh security-key confirmation', async () => {
    const asked = await request(superA, {
      kind: 'admin_create',
      email: `stepup_${newId().slice(0, 8)}@tessera.test`,
      displayName: 'Step up',
    });
    await env.db
      .updateTable('admin_sessions')
      .set({ reauthenticated_at: new Date(Date.now() - 10 * 60_000) })
      .where('admin_id', '=', superB.id)
      .execute();
    const response = await approve(superB, asked.json<{ id: string }>().id);
    expect(code(response)).toBe('STEP_UP_REQUIRED');
    await env.db
      .updateTable('admin_sessions')
      .set({ reauthenticated_at: new Date() })
      .where('admin_id', '=', superB.id)
      .execute();
  });

  it('new admins and moderation staff roles take effect only after approval', async () => {
    const email = `hire_${newId().slice(0, 8)}@tessera.test`;
    const create = await request(superA, { kind: 'admin_create', email, displayName: 'New hire' });
    expect(await admin.admin.directory.byEmail(email)).toBeNull();
    // Security staff cannot add admins.
    expect(
      (await request(security, { kind: 'admin_create', email: 'x@tessera.test', displayName: 'X' }))
        .statusCode,
    ).toBe(403);
    expect((await approve(superB, create.json<{ id: string }>().id)).statusCode).toBe(200);
    expect((await admin.admin.directory.byEmail(email))?.status).toBe('active');

    const user = await person();
    const staffRole = await request(superA, {
      kind: 'staff_role',
      username: user.username,
      role: 'moderator',
      days: 30,
    });
    expect(staffRole.statusCode).toBe(201);
    expect((await approve(security, staffRole.json<{ id: string }>().id)).statusCode).toBe(200);
    const staff = (await security.client.get('/admin/v1/staff-roles')).json<{
      staff: { userId: string; username: string; role: string }[];
    }>();
    expect(staff.staff).toContainEqual(
      expect.objectContaining({ userId: user.id, username: user.username, role: 'moderator' }),
    );

    // Taking a role away is immediate (the safe direction needs no second person).
    const revoke = await security.client.post('/admin/v1/staff-roles/revoke', {
      userId: user.id,
      role: 'moderator',
    });
    expect(revoke.statusCode).toBe(200);
    const after = (await security.client.get('/admin/v1/staff-roles')).json<{
      staff: { userId: string }[];
    }>();
    expect(after.staff.some((s) => s.userId === user.id)).toBe(false);
  });

  it('a failed change goes back to pending', async () => {
    const asked = await request(superA, {
      kind: 'staff_role',
      username: 'nobody_by_this_name',
      role: 'moderator',
      days: 30,
    });
    const id = asked.json<{ id: string }>().id;
    expect((await approve(superB, id)).statusCode).toBe(404);
    const row = await env.db
      .selectFrom('admin_approvals')
      .select(['status', 'decided_by'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: 'pending', decided_by: null });
  });

  it('disabling an admin is immediate: roles revoked, sessions ended, alert raised', async () => {
    const leaver = await makeAdmin(admin, ['support_agent']);
    const response = await security.client.post(`/admin/v1/admins/${leaver.id}/disable`);
    expect(response.statusCode).toBe(200);
    expect((await leaver.client.get('/admin/v1/me')).statusCode).toBe(401);
    expect(await admin.admin.directory.roles(leaver.id)).toEqual([]);
    const listed = (await security.client.get('/admin/v1/admins')).json<{
      admins: { id: string; status: string; keys: number }[];
    }>();
    expect(listed.admins.find((a) => a.id === leaver.id)).toMatchObject({
      status: 'disabled',
      keys: 1,
    });
    expect(
      env.logs
        .records()
        .some((r) => r['event'] === 'admin.alert' && r['check'] === 'admin_disabled'),
    ).toBe(true);
  });
});

// ---- feature flags ----------------------------------------------------------------------------

describe("'flags.mine' and feature flags", () => {
  let superA: TestAdmin;
  let superB: TestAdmin;
  let security: TestAdmin;

  beforeAll(async () => {
    superA = await makeAdmin(admin, ['super_admin']);
    superB = await makeAdmin(admin, ['super_admin']);
    security = await makeAdmin(admin, ['security_admin']);
  });

  async function change(
    requester: TestAdmin,
    approver: TestAdmin,
    key: string,
    enabled: boolean,
    rolloutPercent = 100,
  ): Promise<void> {
    const asked = await requester.client.post('/admin/v1/approvals', {
      payload: { kind: 'feature_flag', key, enabled, rolloutPercent },
      reason: 'Flag change for the test',
    });
    expect(asked.statusCode, asked.body).toBe(201);
    const approved = await approver.client.post(
      `/admin/v1/approvals/${asked.json<{ id: string }>().id}/approve`,
      { note: '' },
    );
    expect(approved.statusCode, approved.body).toBe(200);
  }

  it('security staff switch security flags; product flags need a super admin', async () => {
    const product = await security.client.post('/admin/v1/approvals', {
      payload: { kind: 'feature_flag', key: 'group_calls', enabled: false, rolloutPercent: 100 },
      reason: 'Not my call',
    });
    expect(product.statusCode).toBe(403);
    const unknown = await superA.client.post('/admin/v1/approvals', {
      payload: { kind: 'feature_flag', key: 'no_such_flag', enabled: false, rolloutPercent: 0 },
      reason: 'Does not exist',
    });
    expect(unknown.statusCode).toBe(403);

    const user = await person();
    await change(security, superA, 'link_previews', false);
    expect((await user.client.get('/api/v1/features')).json()).toMatchObject({
      flags: { link_previews: false, group_calls: true },
    });
    const flags = (await security.client.get('/admin/v1/flags')).json<{
      flags: { key: string; enabled: boolean; updatedBy: string | null }[];
    }>();
    expect(flags.flags.find((f) => f.key === 'link_previews')).toMatchObject({
      enabled: false,
      updatedBy: superA.id,
    });
    await change(security, superA, 'link_previews', true);
    expect((await user.client.get('/api/v1/features')).json()).toMatchObject({
      flags: { link_previews: true },
    });
  });

  it('the group-calls kill switch reaches the calls capability', async () => {
    const user = await person();
    await change(superA, superB, 'group_calls', false);
    expect(
      (await user.client.get('/api/v1/calls/capabilities')).json<{ groupCallsAvailable: boolean }>()
        .groupCallsAvailable,
    ).toBe(false);
    await change(superA, superB, 'group_calls', true);
  });

  it('staged rollouts are stable per person', async () => {
    await change(superA, superB, 'group_calls', true, 30);
    const ids = Array.from({ length: 400 }, () => newId());
    const on = await Promise.all(ids.map((id) => env.modules.flags.enabled('group_calls', id)));
    const share = on.filter(Boolean).length / ids.length;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.4);
    for (const [index, id] of ids.entries())
      expect(on[index]).toBe(rolloutBucket('group_calls', id) < 30);
    // Growing the rollout keeps everyone already in it.
    await change(superA, superB, 'group_calls', true, 60);
    for (const [index, id] of ids.entries())
      if (on[index] === true) expect(await env.modules.flags.enabled('group_calls', id)).toBe(true);
    await change(superA, superB, 'group_calls', true, 100);
  });
});

// ---- aggregates, health, audit viewer ----------------------------------------------------------

describe('aggregates, health and the audit viewer', () => {
  it('sign-up counts below five are suppressed', async () => {
    const analyst = await makeAdmin(admin, ['analyst']);
    const DAY = 86_400_000;
    const backdate = async (count: number, daysAgo: number) => {
      const at = new Date(Date.now() - daysAgo * DAY);
      at.setUTCHours(12, 0, 0, 0);
      for (let i = 0; i < count; i += 1) {
        const created = await person();
        await env.db
          .updateTable('users')
          .set({ created_at: at })
          .where('id', '=', created.id)
          .execute();
      }
      return at.toISOString().slice(0, 10);
    };
    const few = await backdate(3, 3);
    const many = await backdate(6, 5);
    const report = (await analyst.client.get('/admin/v1/analytics/signups?days=7')).json<{
      threshold: number;
      days: { date: string; signups: number | null }[];
    }>();
    expect(report.threshold).toBe(5);
    expect(report.days.find((d) => d.date === few)?.signups).toBeNull();
    expect(report.days.find((d) => d.date === many)?.signups).toBe(6);
    // No row is ever a small number.
    for (const d of report.days)
      expect(d.signups === null || d.signups === 0 || d.signups >= 5).toBe(true);
  });

  it('the dashboard shows aggregates only', async () => {
    const analyst = await makeAdmin(admin, ['analyst']);
    const dashboard = await analyst.client.get('/admin/v1/dashboard');
    expect(dashboard.statusCode).toBe(200);
    const body = dashboard.json<{ users: { total: number } }>();
    expect(body.users.total).toBeGreaterThan(0);
    expect(dashboard.body).not.toMatch(/@tessera\.test|username/);
  });

  it('reports the health of every dependency', async () => {
    const analyst = await makeAdmin(admin, ['analyst']);
    const health = (await analyst.client.get('/admin/v1/health')).json<{
      checks: { name: string; ok: boolean }[];
    }>();
    expect(health.checks.map((c) => [c.name, c.ok])).toEqual([
      ['database', true],
      ['cache', true],
      ['object storage', true],
      ['notification queue', true],
    ]);
  });

  it('shows networks with many failed sign-ins', async () => {
    const security = await makeAdmin(admin, ['security_admin']);
    const victim = await person();
    const attacker = new TestClient(env.app);
    for (let i = 0; i < 3; i += 1)
      await attacker.post('/api/v1/auth/login', {
        identifier: victim.username,
        password: 'wrong password entirely',
      });
    const hotspots = (await security.client.get('/admin/v1/security/hotspots?hours=1')).json<{
      hotspots: { ipPrefix: string; failures: number; accounts: number }[];
    }>();
    expect(hotspots.hotspots.some((h) => h.failures >= 3 && h.accounts >= 1)).toBe(true);
  });

  it('staff see their own audit trail; security staff see everything and the chain check', async () => {
    const analyst = await makeAdmin(admin, ['analyst']);
    const security = await makeAdmin(admin, ['security_admin']);
    await analyst.client.get('/admin/v1/dashboard');
    const own = (await analyst.client.get('/admin/v1/audit')).json<{
      entries: { actorId: string | null }[];
      ownOnly: boolean;
      chainBrokenAt: string | null;
    }>();
    expect(own.ownOnly).toBe(true);
    expect(own.entries.length).toBeGreaterThan(0);
    expect(own.entries.every((e) => e.actorId === analyst.id)).toBe(true);
    // Asking for someone else's actions still returns only one's own.
    const sneaky = (await analyst.client.get(`/admin/v1/audit?actorId=${security.id}`)).json<{
      entries: { actorId: string | null }[];
    }>();
    expect(sneaky.entries.every((e) => e.actorId === analyst.id)).toBe(true);

    const all = (await security.client.get('/admin/v1/audit?limit=200')).json<{
      entries: { actorId: string | null }[];
      ownOnly: boolean;
      chainBrokenAt: string | null;
    }>();
    expect(all.ownOnly).toBe(false);
    expect(all.chainBrokenAt).toBeNull();
    expect(new Set(all.entries.map((e) => e.actorId)).size).toBeGreaterThan(1);
    const filtered = (await security.client.get(`/admin/v1/audit?actorId=${analyst.id}`)).json<{
      entries: { actorId: string | null }[];
    }>();
    expect(filtered.entries.every((e) => e.actorId === analyst.id)).toBe(true);
  });

  it('nothing an admin can see contains secrets or message content', async () => {
    const security = await makeAdmin(admin, ['security_admin']);
    const audit = await security.client.get('/admin/v1/audit?limit=200');
    for (const forbidden of ['$argon2', 'token_digest', 'ciphertext', 'recovery_code_hash'])
      expect(audit.body).not.toContain(forbidden);
    expect(audit.body).not.toMatch(/"(password|token|secret)":/);
  });
});
