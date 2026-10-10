import { Alert, Button, Skeleton, TextField } from '@tessera/ui';
import {
  ALL_COMMUNITY_PERMISSIONS,
  COMMUNITY_PERMISSIONS,
  MLS_CIPHERSUITE,
  type communitySchema,
} from '@tessera/validation';
import { useCallback, useEffect, useState, type ReactNode, type SubmitEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { z } from 'zod';

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
import { PageHeading } from '../../components/PageHeading.js';
import { ReportContentDialog } from '../../moderation/ReportContentDialog.js';
import { useResource } from '../../lib/use-resource.js';
import { useMessaging, useMessagingStore } from '../../messaging/provider.js';
import { useSession } from '../../state/session.js';
import { useStepUp } from '../../state/step-up.js';

import { can, PERMISSION_KEYS, PERMISSION_LABELS } from './permissions.js';
import { RulesAgreement } from './RulesAgreement.js';

type Community = z.infer<typeof communitySchema>;

/** One community: join (rules + gate), spaces, members, roles, moderation and settings. */
export function CommunityPage(): ReactNode {
  const { communityId = '' } = useParams();
  const { communityVersion } = useMessaging();
  const load = useCallback(() => endpoints.community(communityId), [communityId]);
  const community = useResource(load);
  const { reload } = community;
  useEffect(() => {
    if (communityVersion > 0) reload();
  }, [communityVersion, reload]);

  if (community.error !== undefined)
    return (
      <div className="settings-page">
        <PageHeading>Community</PageHeading>
        <Alert tone="warning">This community does not exist or is private.</Alert>
        <Link to="/communities">Back to communities</Link>
      </div>
    );
  const data = community.data;
  if (data === undefined)
    return (
      <div className="settings-page">
        <Skeleton height="4rem" shape="tile" />
      </div>
    );
  return <CommunityView key={data.id} community={data} reload={reload} />;
}

function CommunityView({
  community,
  reload,
}: {
  community: Community;
  reload: () => void;
}): ReactNode {
  const { me } = community;
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState(false);

  async function join() {
    setBusy(true);
    setError(undefined);
    try {
      await endpoints.joinCommunity(community.id, community.rulesVersion);
      reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  return (
    <div className="settings-page">
      <PageHeading
        description={`${community.memberCount} ${community.memberCount === 1 ? 'member' : 'members'} · ${community.visibility === 'public' ? 'Public' : 'Private'}`}
      >
        {community.name}
      </PageHeading>
      {community.description === '' ? null : (
        <p className="group-description">{community.description}</p>
      )}
      <p className="t-field__hint">
        The community’s name, rules, roles and member list are visible to Tessera’s servers. Each
        space is an end-to-end encrypted group: only its members’ devices can read it.
      </p>
      <div className="button-row">
        <Button size="sm" variant="ghost" onClick={() => setReporting(true)}>
          Report community
        </Button>
      </div>
      <ReportContentDialog
        target={reporting ? { kind: 'community', communityId: community.id } : null}
        title="Report community"
        onClose={() => setReporting(false)}
      />
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {!me.member ? (
        <section className="settings-section stack" aria-label="Join">
          {me.banned ? (
            <Alert tone="warning">You cannot join this community.</Alert>
          ) : (
            <RulesAgreement
              rules={community.rules}
              minAccountAgeDays={community.minAccountAgeDays}
              busy={busy}
              onJoin={() => void join()}
            />
          )}
        </section>
      ) : (
        <>
          <Spaces community={community} />
          <Members community={community} />
          {can(me.permissions, 'manageRoles') ? <Roles community={community} /> : null}
          {can(me.permissions, 'createInvites') ? <InviteLinks community={community} /> : null}
          {can(me.permissions, 'banMembers') ? <Bans community={community} /> : null}
          {can(me.permissions, 'manageCommunity') ? (
            <Settings community={community} onSaved={reload} />
          ) : (
            <Rules rules={community.rules} />
          )}
          <LeaveOrDelete community={community} onLeft={reload} />
        </>
      )}
    </div>
  );
}

function Rules({ rules }: { rules: string }): ReactNode {
  if (rules === '') return null;
  return (
    <section className="settings-section stack" aria-labelledby="rules-view-heading">
      <h2 id="rules-view-heading">Rules</h2>
      <p className="group-description">{rules}</p>
    </section>
  );
}

// ---- spaces ------------------------------------------------------------------------------------

function Spaces({ community }: { community: Community }): ReactNode {
  const store = useMessagingStore();
  const { communityVersion, spaces: mine } = useMessaging();
  const load = useCallback(() => endpoints.spaces(community.id), [community.id]);
  const spaces = useResource(load);
  const { reload } = spaces;
  // Joining a space happens on an admin's device; our list of spaces changes when it does.
  const joinedKey = Object.keys(mine).sort().join(',');
  useEffect(() => {
    reload();
  }, [joinedKey, reload]);
  const [error, setError] = useState<string>();
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState('');
  const [autoApprove, setAutoApprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const manage = can(community.me.permissions, 'manageSpaces');
  useEffect(() => {
    if (communityVersion > 0) reload();
  }, [communityVersion, reload]);

  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (store === null || name.trim() === '') return;
    setBusy(true);
    setError(undefined);
    try {
      const { id } = await endpoints.createSpace(community.id, {
        name: name.trim(),
        roleIds: roleId === '' ? [] : [roleId],
        autoApprove,
        ciphersuite: MLS_CIPHERSUITE,
      });
      const spaceName = name.trim();
      setName('');
      setRoleId('');
      setAutoApprove(false);
      // Track the new group and give it its name end to end (in the background).
      void store
        .adoptConversation(id)
        .then(() => {
          store.setGroupInfo(id, spaceName, '');
        })
        .catch(() => undefined);
      reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  async function join(spaceId: string) {
    setError(undefined);
    try {
      await endpoints.joinSpace(community.id, spaceId);
      reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function remove(spaceId: string, spaceName: string) {
    if (!window.confirm(`Delete the space “${spaceName}” for everyone?`)) return;
    setError(undefined);
    try {
      await endpoints.deleteSpace(community.id, spaceId);
      reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const roleName = (id: string) => community.roles.find((role) => role.id === id)?.name ?? 'role';
  return (
    <section className="settings-section stack" aria-labelledby="spaces-heading">
      <h2 id="spaces-heading">Spaces</h2>
      {spaces.error === undefined ? null : <Alert tone="danger">{spaces.error}</Alert>}
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {(spaces.data?.spaces ?? []).length === 0 ? (
        <p className="empty">No spaces yet.</p>
      ) : (
        <ul className="member-list" aria-label="Spaces">
          {(spaces.data?.spaces ?? []).map((space) => (
            <li key={space.id} className="member">
              <div className="member__line">
                <strong>{space.name}</strong>
                <span className="badge">End-to-end encrypted</span>
                {space.roleIds.length > 0 ? (
                  <span className="badge badge--muted">
                    {space.roleIds.map(roleName).join(', ')} only
                  </span>
                ) : null}
              </div>
              <p className="t-field__hint">
                {space.autoApprove
                  ? 'Open to eligible members: an admin’s device adds them automatically. The server decides who is eligible.'
                  : 'An admin approves each person who asks to join.'}
              </p>
              <div className="button-row">
                {space.joined ? (
                  <Link
                    className="t-button t-button--secondary t-button--sm"
                    to={`/chats/${space.id}`}
                  >
                    Open
                  </Link>
                ) : space.requested ? (
                  <span role="status">
                    Requested — waiting for a space admin’s device to add you
                  </span>
                ) : (
                  <Button size="sm" onClick={() => void join(space.id)}>
                    Join {space.name}
                  </Button>
                )}
                {manage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void remove(space.id, space.name)}
                  >
                    Delete
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {manage ? (
        <form className="stack" aria-label="New space" onSubmit={(event) => void create(event)}>
          <TextField
            label="New space name"
            maxLength={60}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <label className="t-field">
            <span className="t-field__label">Who can join</span>
            <select
              className="t-field__input"
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
            >
              <option value="">Every member</option>
              {community.roles.map((role) => (
                <option key={role.id} value={role.id}>
                  Only {role.name}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
            />
            Add eligible members automatically (trusts the server’s member list)
          </label>
          <div className="button-row">
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              loading={busy}
              loadingLabel="Creating"
            >
              Create space
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

// ---- members -----------------------------------------------------------------------------------

function Members({ community }: { community: Community }): ReactNode {
  const { withStepUp } = useStepUp();
  const session = useSession();
  const myId = session.me?.id ?? '';
  const [cursor, setCursor] = useState<string | undefined>();
  const load = useCallback(
    () => endpoints.communityMembers(community.id, cursor),
    [community.id, cursor],
  );
  const members = useResource(load);
  const [error, setError] = useState<string>();
  const { me } = community;
  const rankOf = (roleIds: readonly string[], owner: boolean) =>
    owner
      ? 1001
      : Math.max(
          0,
          ...community.roles.filter((r) => roleIds.includes(r.id)).map((r) => r.position),
        );
  const assignable = community.roles.filter((role) => role.position < me.rank);

  async function act(action: () => Promise<unknown>) {
    setError(undefined);
    try {
      await action();
      members.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="settings-section stack" aria-labelledby="community-members-heading">
      <h2 id="community-members-heading">
        Members <span className="badge">{community.memberCount}</span>
      </h2>
      {members.error === undefined ? null : <Alert tone="danger">{members.error}</Alert>}
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <ul className="member-list">
        {(members.data?.members ?? []).map((member) => {
          const self = member.userId === myId;
          const below = rankOf(member.roleIds, member.owner) < me.rank && !member.owner;
          return (
            <li key={member.userId} className="member">
              <div className="member__line">
                <span>@{member.username}</span>
                {member.owner ? <span className="badge">Owner</span> : null}
                {community.roles
                  .filter((role) => member.roleIds.includes(role.id))
                  .map((role) => (
                    <span key={role.id} className="badge badge--muted">
                      {role.name}
                    </span>
                  ))}
              </div>
              {self || !below ? null : (
                <div className="button-row">
                  {can(me.permissions, 'manageRoles') && assignable.length > 0 ? (
                    <label className="t-field">
                      <span className="visually-hidden">Role for @{member.username}</span>
                      <select
                        className="t-field__input"
                        aria-label={`Role for @${member.username}`}
                        value={
                          member.roleIds.find((id) => assignable.some((r) => r.id === id)) ?? ''
                        }
                        onChange={(e) =>
                          void act(() =>
                            endpoints.setCommunityMemberRoles(community.id, member.userId, [
                              ...member.roleIds.filter(
                                (id) => !assignable.some((r) => r.id === id),
                              ),
                              ...(e.target.value === '' ? [] : [e.target.value]),
                            ]),
                          )
                        }
                      >
                        <option value="">No role</option>
                        {assignable.map((role) => (
                          <option key={role.id} value={role.id}>
                            {role.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {can(me.permissions, 'kickMembers') ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Remove @${member.username} from the community and its spaces?`,
                          )
                        )
                          void act(() => endpoints.kickFromCommunity(community.id, member.userId));
                      }}
                    >
                      Remove
                    </Button>
                  ) : null}
                  {can(me.permissions, 'banMembers') ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Ban @${member.username}? They cannot rejoin until unbanned.`,
                          )
                        )
                          void act(() => endpoints.banFromCommunity(community.id, member.userId));
                      }}
                    >
                      Ban
                    </Button>
                  ) : null}
                  {me.owner ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (window.confirm(`Make @${member.username} the owner of this community?`))
                          void act(() =>
                            withStepUp(() =>
                              endpoints.transferCommunity(community.id, member.userId),
                            ),
                          );
                      }}
                    >
                      Make owner
                    </Button>
                  ) : null}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {members.data?.nextCursor == null ? null : (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setCursor(members.data?.nextCursor ?? undefined)}
        >
          Next page
        </Button>
      )}
    </section>
  );
}

// ---- roles -------------------------------------------------------------------------------------

function Roles({ community }: { community: Community }): ReactNode {
  const { me } = community;
  const [name, setName] = useState('');
  const [position, setPosition] = useState(String(Math.max(1, Math.min(me.rank - 1, 10))));
  const [permissions, setPermissions] = useState(0);
  const [error, setError] = useState<string>();
  const grantable = me.owner ? ALL_COMMUNITY_PERMISSIONS : me.permissions;

  async function create(event: SubmitEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await endpoints.createCommunityRole(community.id, {
        name: name.trim(),
        position: Number(position),
        permissions,
      });
      setName('');
      setPermissions(0);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function remove(roleId: string) {
    setError(undefined);
    try {
      await endpoints.deleteCommunityRole(community.id, roleId);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="settings-section stack" aria-labelledby="roles-heading">
      <h2 id="roles-heading">Roles</h2>
      <p className="t-field__hint">
        Higher positions outrank lower ones. You can manage roles and members below your highest
        role ({me.owner ? 'owner' : `position ${me.rank}`}), and only grant permissions you have.
      </p>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <ul className="member-list" aria-label="Roles">
        {community.roles.map((role) => (
          <li key={role.id} className="member">
            <div className="member__line">
              <strong>{role.name}</strong>
              <span className="badge badge--muted">position {role.position}</span>
            </div>
            <p className="t-field__hint">
              {PERMISSION_KEYS.filter((key) => can(role.permissions, key))
                .map((key) => PERMISSION_LABELS[key])
                .join(' · ') || 'No moderation permissions'}
            </p>
            {role.position < me.rank ? (
              <Button size="sm" variant="ghost" onClick={() => void remove(role.id)}>
                Delete role
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      <form className="stack" aria-label="New role" onSubmit={(event) => void create(event)}>
        <TextField
          label="Role name"
          maxLength={32}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="Position (1–1000)"
          inputMode="numeric"
          value={position}
          onChange={(e) => setPosition(e.target.value.replace(/\D/g, ''))}
        />
        <fieldset className="stack">
          <legend>Permissions</legend>
          {PERMISSION_KEYS.map((key) => (
            <label key={key} className="checkbox">
              <input
                type="checkbox"
                disabled={(grantable & COMMUNITY_PERMISSIONS[key]) === 0}
                checked={can(permissions, key)}
                onChange={() => setPermissions(permissions ^ COMMUNITY_PERMISSIONS[key])}
              />
              {PERMISSION_LABELS[key]}
            </label>
          ))}
        </fieldset>
        <div className="button-row">
          <Button type="submit" size="sm" variant="secondary" disabled={name.trim() === ''}>
            Create role
          </Button>
        </div>
      </form>
    </section>
  );
}

// ---- invite links and bans -----------------------------------------------------------------------

function InviteLinks({ community }: { community: Community }): ReactNode {
  const load = useCallback(() => endpoints.communityLinks(community.id), [community.id]);
  const links = useResource(load);
  const [created, setCreated] = useState<string>();
  const [error, setError] = useState<string>();

  async function create() {
    setError(undefined);
    try {
      const link = await endpoints.createCommunityLink(community.id, {
        expiresInHours: 24 * 7,
        maxUses: null,
      });
      setCreated(`${window.location.origin}/join/${link.token}`);
      links.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="settings-section stack" aria-labelledby="community-links-heading">
      <h2 id="community-links-heading">Invite links</h2>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {created === undefined ? null : (
        <Alert tone="success" title="Link created">
          <p>Copy it now; it is not shown again. It expires in 7 days.</p>
          <code className="secret">{created}</code>
        </Alert>
      )}
      <div className="button-row">
        <Button size="sm" variant="secondary" onClick={() => void create()}>
          Create invite link
        </Button>
      </div>
      {(links.data?.links ?? []).length === 0 ? null : (
        <ul className="member-list" aria-label="Active community invite links">
          {(links.data?.links ?? []).map((link) => (
            <li key={link.id} className="member">
              <span>
                {link.uses} used · expires {new Date(link.expiresAt).toLocaleDateString()}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void endpoints
                    .revokeCommunityLink(community.id, link.id)
                    .then(links.reload, (caught: unknown) => {
                      setError(errorMessage(caught));
                    })
                }
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Bans({ community }: { community: Community }): ReactNode {
  const load = useCallback(() => endpoints.communityBans(community.id), [community.id]);
  const bans = useResource(load);
  const list = bans.data?.bans ?? [];
  if (list.length === 0) return null;
  return (
    <section className="settings-section stack" aria-labelledby="community-bans-heading">
      <h2 id="community-bans-heading">Banned</h2>
      <ul className="member-list">
        {list.map((ban) => (
          <li key={ban.userId} className="member">
            <span>@{ban.username}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void endpoints
                  .unbanFromCommunity(community.id, ban.userId)
                  .then(bans.reload, () => undefined)
              }
            >
              Unban
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- settings, leaving, deleting -----------------------------------------------------------------

function Settings({
  community,
  onSaved,
}: {
  community: Community;
  onSaved: () => void;
}): ReactNode {
  const [name, setName] = useState(community.name);
  const [description, setDescription] = useState(community.description);
  const [rules, setRules] = useState(community.rules);
  const [visibility, setVisibility] = useState(community.visibility);
  const [minAge, setMinAge] = useState(String(community.minAccountAgeDays));
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string }>();

  async function save(event: SubmitEvent) {
    event.preventDefault();
    setMessage(undefined);
    try {
      await endpoints.updateCommunity(community.id, {
        name: name.trim(),
        description: description.trim(),
        rules: rules.trim(),
        visibility,
        minAccountAgeDays: Math.min(365, Number(minAge) || 0),
      });
      setMessage({
        tone: 'success',
        text:
          rules.trim() === community.rules
            ? 'Saved.'
            : 'Saved. New members must accept the updated rules.',
      });
      onSaved();
    } catch (caught) {
      setMessage({ tone: 'danger', text: errorMessage(caught) });
    }
  }

  return (
    <form
      className="settings-section stack"
      aria-labelledby="community-settings-heading"
      onSubmit={(event) => void save(event)}
    >
      <h2 id="community-settings-heading">Settings</h2>
      <TextField
        label="Name"
        minLength={3}
        maxLength={60}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <TextField
        label="Description"
        maxLength={500}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <label className="t-field">
        <span className="t-field__label">Rules</span>
        <textarea
          className="t-field__input"
          rows={4}
          maxLength={4000}
          value={rules}
          onChange={(e) => setRules(e.target.value)}
        />
      </label>
      <label className="t-field">
        <span className="t-field__label">Who can find it</span>
        <select
          className="t-field__input"
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as 'public' | 'private')}
        >
          <option value="private">Private — invite links only</option>
          <option value="public">Public — listed in Discover</option>
        </select>
      </label>
      <TextField
        label="Minimum account age to join (days)"
        inputMode="numeric"
        value={minAge}
        onChange={(e) => setMinAge(e.target.value.replace(/\D/g, ''))}
      />
      {message === undefined ? null : <Alert tone={message.tone}>{message.text}</Alert>}
      <div className="button-row">
        <Button type="submit" size="sm" variant="secondary">
          Save
        </Button>
      </div>
    </form>
  );
}

function LeaveOrDelete({
  community,
  onLeft,
}: {
  community: Community;
  onLeft: () => void;
}): ReactNode {
  const { withStepUp } = useStepUp();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  return (
    <section className="settings-section stack" aria-label="Leave or delete">
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {community.me.owner ? (
        <Button
          variant="danger"
          onClick={() => {
            if (!window.confirm('Delete this community and all its spaces for everyone?')) return;
            void withStepUp(() => endpoints.deleteCommunity(community.id)).then(
              (done) => {
                if (done !== undefined) void navigate('/communities');
              },
              (caught: unknown) => setError(errorMessage(caught)),
            );
          }}
        >
          Delete community
        </Button>
      ) : (
        <Button
          variant="secondary"
          onClick={() => {
            if (!window.confirm('Leave this community? You will leave all its spaces.')) return;
            void endpoints.leaveCommunity(community.id).then(onLeft, (caught: unknown) => {
              setError(errorMessage(caught));
            });
          }}
        >
          Leave community
        </Button>
      )}
    </section>
  );
}
