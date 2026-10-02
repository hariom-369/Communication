import { Alert, Button, TextField } from '@tessera/ui';
import { useCallback, useEffect, useState, type ReactNode, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
import { MAX_GROUP_DESCRIPTION, MAX_GROUP_NAME } from '../../messaging/content.js';
import { roleIn } from '../../messaging/e2ee.js';
import { useMessagingStore } from '../../messaging/provider.js';
import type { ConversationView } from '../../messaging/store.js';
import { useResource } from '../../lib/use-resource.js';
import { useStepUp } from '../../state/step-up.js';

import { parseUsernames } from './NewGroupDialog.js';
import { SafetyNumber } from './SafetyNumber.js';

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const;

const LINK_EXPIRY = [
  { hours: 24, label: '1 day' },
  { hours: 24 * 7, label: '7 days' },
  { hours: 24 * 30, label: '30 days' },
] as const;

/**
 * Group details and administration (docs/groups.md). Roles shown here are the end-to-end
 * authenticated ones from the group's encryption state, not the server's copy.
 */
export function GroupPanel({
  conversation,
  myId,
}: {
  conversation: ConversationView;
  myId: string;
}): ReactNode {
  const store = useMessagingStore();
  const { withStepUp } = useStepUp();
  const navigate = useNavigate();
  const { meta, timeline, security } = conversation;
  const policy = security.policy;
  const myRole = roleIn(policy, myId);
  const isAdmin = myRole === 'owner' || myRole === 'admin';
  const canEditInfo = isAdmin || policy?.membersCanEditInfo === true;
  const canAdd = isAdmin || policy?.membersCanAdd === true;
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);

  async function run(label: string, action: () => Promise<unknown>, done?: string) {
    setBusy(label);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
      if (done !== undefined) setNotice(done);
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(null);
  }

  if (store === null) return null;
  const outOfSync = store.serverCopyOutOfSync(meta.id);
  const awaiting = new Set(security.awaitingAdd);
  const unconfirmed = meta.members.filter((m) => security.unconfirmed.includes(m.userId));

  return (
    <div className="group-panel stack">
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {notice === undefined ? null : <Alert tone="success">{notice}</Alert>}
      {conversation.removed ? (
        <Alert tone="info">You are no longer a member of this group.</Alert>
      ) : null}

      <GroupInfoForm
        key={`${timeline.group.name ?? ''}\u0000${timeline.group.description}`}
        name={timeline.group.name ?? ''}
        description={timeline.group.description}
        editable={canEditInfo && !conversation.removed}
        onSave={(name, description) => {
          store.setGroupInfo(meta.id, name, description);
          setNotice('Saved. The new name is sent to members end-to-end encrypted.');
        }}
      />

      <p className="t-field__hint">
        Messages, the group name, its description, pins and polls are end-to-end encrypted. The
        server knows who is in the group and their roles, but not what is said.
      </p>

      {outOfSync ? (
        <Alert tone="warning" title="Finish saving">
          <p>The server has not caught up with the last change to roles or settings.</p>
          <Button
            size="sm"
            loading={busy === 'sync'}
            loadingLabel="Saving"
            onClick={() => void run('sync', () => store.syncServerCopy(meta.id, withStepUp))}
          >
            Finish saving
          </Button>
        </Alert>
      ) : null}

      <section aria-labelledby="members-heading" className="stack">
        <h3 id="members-heading">
          Members <span className="badge">{meta.members.length}</span>
        </h3>
        {unconfirmed.length > 0 && canAdd ? (
          <Alert tone="warning" title="Not added yet">
            <p>
              The server lists {unconfirmed.map((m) => `@${m.username}`).join(', ')} as{' '}
              {unconfirmed.length === 1 ? 'a member' : 'members'}, but no admin has confirmed adding{' '}
              {unconfirmed.length === 1 ? 'them' : 'these people'} on an encrypted device. Only
              confirm people you expect to be here.
            </p>
            <Button
              size="sm"
              onClick={() =>
                store.confirmMembers(
                  meta.id,
                  unconfirmed.map((m) => m.userId),
                )
              }
            >
              Confirm and add
            </Button>
          </Alert>
        ) : null}
        <ul className="member-list">
          {meta.members.map((member) => {
            const role = roleIn(policy, member.userId) ?? member.role;
            const self = member.userId === myId;
            const canRemove =
              !self &&
              role !== 'owner' &&
              (role === 'admin' ? myRole === 'owner' : isAdmin) &&
              !conversation.removed;
            return (
              <li key={member.userId} className="member">
                <div className="member__line">
                  <span>
                    @{member.username}
                    {self ? ' (you)' : ''}
                  </span>
                  <span className="badge">{ROLE_LABEL[role]}</span>
                  {awaiting.has(member.userId) ? (
                    <span className="badge badge--muted">Joining…</span>
                  ) : null}
                  {security.verified.includes(member.userId) ? (
                    <span className="verified-badge">Verified</span>
                  ) : null}
                </div>
                {self ? null : (
                  <div className="button-row">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-expanded={verifying === member.userId}
                      onClick={() =>
                        setVerifying(verifying === member.userId ? null : member.userId)
                      }
                    >
                      Safety number
                    </Button>
                    {myRole === 'owner' && role !== 'owner' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === `role:${member.userId}`}
                        loadingLabel="Saving"
                        onClick={() =>
                          void run(`role:${member.userId}`, () =>
                            store.setRole(
                              meta.id,
                              member.userId,
                              role === 'admin' ? 'member' : 'admin',
                            ),
                          )
                        }
                      >
                        {role === 'admin' ? 'Remove admin' : 'Make admin'}
                      </Button>
                    ) : null}
                    {myRole === 'owner' && role === 'admin' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busy === `owner:${member.userId}`}
                        loadingLabel="Transferring"
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Make @${member.username} the owner? You will stay an admin.`,
                            )
                          )
                            return;
                          void run(`owner:${member.userId}`, () =>
                            store.transferOwnership(meta.id, member.userId, withStepUp),
                          );
                        }}
                      >
                        Make owner
                      </Button>
                    ) : null}
                    {canRemove ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busy === `remove:${member.userId}`}
                          loadingLabel="Removing"
                          onClick={() => {
                            if (!window.confirm(`Remove @${member.username} from the group?`))
                              return;
                            void run(`remove:${member.userId}`, () =>
                              store.removeMember(meta.id, member.userId, false),
                            );
                          }}
                        >
                          Remove
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busy === `ban:${member.userId}`}
                          loadingLabel="Banning"
                          onClick={() => {
                            if (
                              !window.confirm(
                                `Remove and ban @${member.username}? They cannot rejoin until unbanned.`,
                              )
                            )
                              return;
                            void run(`ban:${member.userId}`, () =>
                              store.removeMember(meta.id, member.userId, true),
                            );
                          }}
                        >
                          Ban
                        </Button>
                      </>
                    ) : null}
                  </div>
                )}
                {verifying === member.userId ? (
                  <SafetyNumber
                    conversationId={meta.id}
                    userId={member.userId}
                    username={member.username}
                    verified={security.verified.includes(member.userId)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
        {canAdd && !conversation.removed ? <AddPeople conversationId={meta.id} /> : null}
      </section>

      {isAdmin && policy !== null && !conversation.removed ? (
        <SettingsForm
          key={JSON.stringify(policy)}
          initial={{
            membersCanAdd: policy.membersCanAdd,
            membersCanEditInfo: policy.membersCanEditInfo,
            announcementsOnly: policy.announcementsOnly,
          }}
          busy={busy === 'settings'}
          onSave={(settings) =>
            void run('settings', () => store.updateGroupSettings(meta.id, settings), 'Saved.')
          }
        />
      ) : null}

      {isAdmin && !conversation.removed ? (
        <>
          <JoinRequests conversationId={meta.id} hint={conversation.requestHint} />
          <InviteLinks conversationId={meta.id} />
          <Bans conversationId={meta.id} />
        </>
      ) : null}

      {conversation.removed ? null : (
        <section className="stack" aria-label="Leave or delete">
          <Button
            variant="secondary"
            loading={busy === 'leave'}
            loadingLabel="Leaving"
            onClick={() => {
              if (myRole === 'owner' && meta.members.length > 1) {
                setError('Make another admin the owner before leaving.');
                return;
              }
              if (!window.confirm('Leave this group?')) return;
              void run('leave', () => store.leaveGroup(meta.id));
            }}
          >
            Leave group
          </Button>
          {myRole === 'owner' ? (
            <Button
              variant="danger"
              loading={busy === 'delete'}
              loadingLabel="Deleting"
              onClick={() => {
                if (!window.confirm('Delete this group for everyone? This cannot be undone.'))
                  return;
                void run('delete', async () => {
                  if (await store.deleteGroup(meta.id, withStepUp)) await navigate('/chats');
                });
              }}
            >
              Delete group
            </Button>
          ) : null}
        </section>
      )}
    </div>
  );
}

function GroupInfoForm(props: {
  name: string;
  description: string;
  editable: boolean;
  onSave: (name: string, description: string) => void;
}): ReactNode {
  const [name, setName] = useState(props.name);
  const [description, setDescription] = useState(props.description);
  if (!props.editable)
    return (
      <section className="stack" aria-label="About this group">
        <h3>{props.name === '' ? 'Group' : props.name}</h3>
        {props.description === '' ? null : <p className="group-description">{props.description}</p>}
      </section>
    );
  const changed = name.trim() !== props.name || description.trim() !== props.description;
  return (
    <form
      className="stack"
      aria-label="About this group"
      onSubmit={(event: SubmitEvent) => {
        event.preventDefault();
        if (name.trim() !== '' && changed) props.onSave(name, description);
      }}
    >
      <TextField
        label="Group name"
        required
        maxLength={MAX_GROUP_NAME}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <label className="t-field">
        <span className="t-field__label">Description</span>
        <textarea
          className="t-field__input"
          rows={3}
          maxLength={MAX_GROUP_DESCRIPTION}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <div className="button-row">
        <Button type="submit" size="sm" variant="secondary" disabled={!changed}>
          Save
        </Button>
      </div>
    </form>
  );
}

function AddPeople({ conversationId }: { conversationId: string }): ReactNode {
  const store = useMessagingStore();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'success' | 'danger'; text: string }>();

  async function add(event: SubmitEvent) {
    event.preventDefault();
    const usernames = parseUsernames(value);
    if (store === null || usernames.length === 0) return;
    setBusy(true);
    setResult(undefined);
    try {
      const outcome = await store.addMembers(conversationId, usernames);
      setValue('');
      const parts = [
        outcome.added.length > 0 ? `Added @${outcome.added.join(', @')}` : '',
        outcome.invited.length > 0 ? `Invited @${outcome.invited.join(', @')}` : '',
        outcome.skipped.length > 0 ? `Could not add @${outcome.skipped.join(', @')}` : '',
      ].filter((part) => part !== '');
      setResult({ tone: 'success', text: `${parts.join('. ')}.` });
    } catch (caught) {
      setResult({ tone: 'danger', text: errorMessage(caught) });
    }
    setBusy(false);
  }

  return (
    <form className="stack" onSubmit={(event) => void add(event)}>
      <TextField
        label="Add people"
        placeholder="username, username"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="button-row">
        <Button type="submit" size="sm" variant="secondary" loading={busy} loadingLabel="Adding">
          Add
        </Button>
      </div>
      {result === undefined ? null : <Alert tone={result.tone}>{result.text}</Alert>}
    </form>
  );
}

function SettingsForm(props: {
  initial: { membersCanAdd: boolean; membersCanEditInfo: boolean; announcementsOnly: boolean };
  busy: boolean;
  onSave: (settings: {
    membersCanAdd: boolean;
    membersCanEditInfo: boolean;
    announcementsOnly: boolean;
  }) => void;
}): ReactNode {
  const [settings, setSettings] = useState(props.initial);
  const changed = JSON.stringify(settings) !== JSON.stringify(props.initial);
  const toggle = (key: keyof typeof settings) =>
    setSettings({ ...settings, [key]: !settings[key] });
  return (
    <form
      className="stack"
      aria-labelledby="group-settings-heading"
      onSubmit={(event: SubmitEvent) => {
        event.preventDefault();
        props.onSave(settings);
      }}
    >
      <h3 id="group-settings-heading">Settings</h3>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.membersCanAdd}
          onChange={() => toggle('membersCanAdd')}
        />
        Members can add people
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.membersCanEditInfo}
          onChange={() => toggle('membersCanEditInfo')}
        />
        Members can change the name and description
      </label>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={settings.announcementsOnly}
          onChange={() => toggle('announcementsOnly')}
        />
        Only admins can send messages
      </label>
      <div className="button-row">
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={!changed}
          loading={props.busy}
          loadingLabel="Saving"
        >
          Save settings
        </Button>
      </div>
    </form>
  );
}

function JoinRequests({
  conversationId,
  hint,
}: {
  conversationId: string;
  hint: number;
}): ReactNode {
  const store = useMessagingStore();
  const load = useCallback(() => endpoints.joinRequests(conversationId), [conversationId]);
  const requests = useResource(load);
  const [error, setError] = useState<string>();
  const { reload } = requests;
  useEffect(() => {
    if (hint > 0) reload();
  }, [hint, reload]);

  async function resolve(userId: string, approve: boolean) {
    setError(undefined);
    try {
      if (approve) await store?.approveJoinRequest(conversationId, userId);
      else await endpoints.rejectJoinRequest(conversationId, userId);
      reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  const list = requests.data?.requests ?? [];
  return (
    <section className="stack" aria-labelledby="requests-heading">
      <h3 id="requests-heading">
        Requests to join {list.length > 0 ? <span className="badge">{list.length}</span> : null}
      </h3>
      {requests.error === undefined ? null : <Alert tone="danger">{requests.error}</Alert>}
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {list.length === 0 ? (
        <p className="empty">No pending requests.</p>
      ) : (
        <ul className="member-list">
          {list.map((request) => (
            <li key={request.userId} className="member">
              <span>@{request.username}</span>
              <div className="button-row">
                <Button size="sm" onClick={() => void resolve(request.userId, true)}>
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void resolve(request.userId, false)}
                >
                  Decline
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InviteLinks({ conversationId }: { conversationId: string }): ReactNode {
  const load = useCallback(() => endpoints.inviteLinks(conversationId), [conversationId]);
  const links = useResource(load);
  const [hours, setHours] = useState<number>(LINK_EXPIRY[1].hours);
  const [maxUses, setMaxUses] = useState('');
  const [title, setTitle] = useState('');
  const [created, setCreated] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function create(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const uses = maxUses.trim() === '' ? null : Number(maxUses);
      const link = await endpoints.createInviteLink(conversationId, {
        expiresInHours: hours,
        maxUses: uses !== null && Number.isInteger(uses) && uses > 0 ? uses : null,
        previewTitle: title.trim() === '' ? null : title.trim(),
      });
      setCreated(`${window.location.origin}/invite/${link.token}`);
      setTitle('');
      setMaxUses('');
      links.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
    setBusy(false);
  }

  async function revoke(linkId: string) {
    setError(undefined);
    try {
      await endpoints.revokeInviteLink(conversationId, linkId);
      links.reload();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="stack" aria-labelledby="links-heading">
      <h3 id="links-heading">Invite links</h3>
      <p className="t-field__hint">
        Anyone with a link can ask to join; an admin approves each request. The link itself never
        reveals the group’s name unless you add a preview title, which the server can read.
      </p>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {created === undefined ? null : (
        <Alert tone="success" title="Link created">
          <p>Copy it now; it is not shown again.</p>
          <code className="secret">{created}</code>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void navigator.clipboard.writeText(created).catch(() => undefined)}
          >
            Copy link
          </Button>
        </Alert>
      )}
      <form className="stack" onSubmit={(event) => void create(event)}>
        <label className="t-field">
          <span className="t-field__label">Expires after</span>
          <select
            className="t-field__input"
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            {LINK_EXPIRY.map((option) => (
              <option key={option.hours} value={option.hours}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <TextField
          label="Maximum uses (optional)"
          inputMode="numeric"
          value={maxUses}
          onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, ''))}
        />
        <TextField
          label="Preview title (optional, visible to the server)"
          maxLength={80}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="button-row">
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            loading={busy}
            loadingLabel="Creating"
          >
            Create invite link
          </Button>
        </div>
      </form>
      {(links.data?.links ?? []).length === 0 ? null : (
        <ul className="member-list" aria-label="Active invite links">
          {(links.data?.links ?? []).map((link) => (
            <li key={link.id} className="member">
              <span>
                {link.previewTitle ?? 'Link'} · {link.uses}
                {link.maxUses === null ? '' : `/${link.maxUses}`} used · expires{' '}
                {new Date(link.expiresAt).toLocaleDateString()}
              </span>
              <Button size="sm" variant="ghost" onClick={() => void revoke(link.id)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Bans({ conversationId }: { conversationId: string }): ReactNode {
  const load = useCallback(() => endpoints.bans(conversationId), [conversationId]);
  const bans = useResource(load);
  const [error, setError] = useState<string>();
  const list = bans.data?.bans ?? [];
  if (list.length === 0 && error === undefined) return null;
  return (
    <section className="stack" aria-labelledby="bans-heading">
      <h3 id="bans-heading">Banned</h3>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <ul className="member-list">
        {list.map((ban) => (
          <li key={ban.userId} className="member">
            <span>@{ban.username}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void endpoints
                  .unban(conversationId, ban.userId)
                  .then(bans.reload, (caught: unknown) => {
                    setError(errorMessage(caught));
                  })
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
