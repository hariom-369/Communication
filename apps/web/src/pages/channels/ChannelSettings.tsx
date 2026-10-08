import { Alert, Button, TextField } from '@tessera/ui';
import {
  CHANNEL_PERMISSIONS,
  OWNERSHIP_COOLDOWN_HOURS,
  type channelSchema,
} from '@tessera/validation';
import { useCallback, useState, type ReactNode, type SubmitEvent } from 'react';
import { useNavigate } from 'react-router';
import type { z } from 'zod';

import { errorMessage } from '../../api/client.js';
import { endpoints } from '../../api/endpoints.js';
import { useResource } from '../../lib/use-resource.js';
import { useStepUp } from '../../state/step-up.js';

import { canChannel, CHANNEL_PERMISSION_KEYS, CHANNEL_PERMISSION_LABELS } from './shared.js';

type Channel = z.infer<typeof channelSchema>;

const SLOW_MODE = [
  { value: 0, label: 'Off' },
  { value: 10, label: '10 seconds' },
  { value: 60, label: '1 minute' },
  { value: 300, label: '5 minutes' },
  { value: 3600, label: '1 hour' },
] as const;

export function ChannelSettings({
  channel,
  onChanged,
}: {
  channel: Channel;
  onChanged: () => void;
}): ReactNode {
  const perms = channel.me.permissions;
  // One admin list for both the admin editor and the ownership hand-over.
  const loadAdmins = useCallback(() => endpoints.channelAdmins(channel.id), [channel.id]);
  const admins = useResource(loadAdmins);
  return (
    <div className="stack">
      {canChannel(perms, 'editChannelInfo') ? (
        <InfoForm channel={channel} onSaved={onChanged} />
      ) : null}
      <Admins channel={channel} admins={admins.data} reload={admins.reload} onChanged={onChanged} />
      {canChannel(perms, 'editChannelInfo') && channel.visibility === 'private' ? (
        <InviteLinks channel={channel} />
      ) : null}
      {channel.me.owner ? (
        <Ownership channel={channel} admins={admins.data} onChanged={onChanged} />
      ) : null}
    </div>
  );
}

function InfoForm({ channel, onSaved }: { channel: Channel; onSaved: () => void }): ReactNode {
  const [title, setTitle] = useState(channel.title);
  const [description, setDescription] = useState(channel.description);
  const [visibility, setVisibility] = useState(channel.visibility);
  const [comments, setComments] = useState(channel.commentsEnabled);
  const [slowMode, setSlowMode] = useState(channel.slowModeSeconds);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string }>();

  async function save(event: SubmitEvent) {
    event.preventDefault();
    setMessage(undefined);
    try {
      await endpoints.updateChannel(channel.id, {
        title: title.trim(),
        description: description.trim(),
        visibility,
        commentsEnabled: comments,
        slowModeSeconds: slowMode,
      });
      setMessage({ tone: 'success', text: 'Saved.' });
      onSaved();
    } catch (caught) {
      setMessage({ tone: 'danger', text: errorMessage(caught) });
    }
  }

  return (
    <form
      className="settings-section stack"
      aria-labelledby="channel-info-heading"
      onSubmit={(event) => void save(event)}
    >
      <h2 id="channel-info-heading">Channel info</h2>
      <TextField
        label="Title"
        maxLength={80}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <TextField
        label="Description"
        maxLength={1000}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <label className="t-field">
        <span className="t-field__label">Who can find it</span>
        <select
          className="t-field__input"
          value={visibility}
          onChange={(e) => setVisibility(e.target.value as 'public' | 'private')}
        >
          <option value="public">Public — anyone can find and read it</option>
          <option value="private">Private — invite links only</option>
        </select>
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={comments} onChange={(e) => setComments(e.target.checked)} />
        Subscribers can comment
      </label>
      <label className="t-field">
        <span className="t-field__label">Slow mode for comments</span>
        <select
          className="t-field__input"
          value={slowMode}
          onChange={(e) => setSlowMode(Number(e.target.value))}
        >
          {SLOW_MODE.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {message === undefined ? null : <Alert tone={message.tone}>{message.text}</Alert>}
      <div className="button-row">
        <Button type="submit" size="sm" variant="secondary">
          Save
        </Button>
      </div>
    </form>
  );
}

function PermissionBoxes(props: {
  value: number;
  grantable: number;
  onChange: (value: number) => void;
  label: string;
}): ReactNode {
  return (
    <fieldset className="stack">
      <legend>{props.label}</legend>
      {CHANNEL_PERMISSION_KEYS.map((key) => (
        <label key={key} className="checkbox">
          <input
            type="checkbox"
            disabled={(props.grantable & CHANNEL_PERMISSIONS[key]) === 0}
            checked={(props.value & CHANNEL_PERMISSIONS[key]) !== 0}
            onChange={() => props.onChange(props.value ^ CHANNEL_PERMISSIONS[key])}
          />
          {CHANNEL_PERMISSION_LABELS[key]}
        </label>
      ))}
    </fieldset>
  );
}

type AdminList = Awaited<ReturnType<typeof endpoints.channelAdmins>>;

function Admins(props: {
  channel: Channel;
  admins: AdminList | undefined;
  reload: () => void;
  onChanged: () => void;
}): ReactNode {
  const { channel, onChanged } = props;
  const [username, setUsername] = useState('');
  const [permissions, setPermissions] = useState<number>(CHANNEL_PERMISSIONS.post);
  const [error, setError] = useState<string>();
  const manage = canChannel(channel.me.permissions, 'manageAdmins');
  const grantable = channel.me.permissions;

  async function act(action: () => Promise<unknown>) {
    setError(undefined);
    try {
      await action();
      props.reload();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="settings-section stack" aria-labelledby="channel-admins-heading">
      <h2 id="channel-admins-heading">Admins</h2>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      <ul className="member-list">
        {(props.admins?.admins ?? []).map((admin, index) => (
          <li key={admin.userId} className="member">
            <div className="member__line">
              <span>@{admin.username}</span>
              <span className="badge">{index === 0 ? 'Owner' : 'Admin'}</span>
            </div>
            {index === 0 ? null : (
              <>
                <p className="t-field__hint">
                  {CHANNEL_PERMISSION_KEYS.filter((key) => canChannel(admin.permissions, key))
                    .map((key) => CHANNEL_PERMISSION_LABELS[key])
                    .join(' · ')}
                </p>
                {manage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void act(() => endpoints.removeChannelAdmin(channel.id, admin.userId))
                    }
                  >
                    Remove admin
                  </Button>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
      {manage ? (
        <form
          className="stack"
          aria-label="Add an admin"
          onSubmit={(event: SubmitEvent) => {
            event.preventDefault();
            void act(async () => {
              await endpoints.addChannelAdmin(
                channel.id,
                username.trim().replace(/^@/, ''),
                permissions,
              );
              setUsername('');
            });
          }}
        >
          <TextField
            label="Add an admin"
            placeholder="username"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <PermissionBoxes
            label="Permissions"
            value={permissions}
            grantable={grantable}
            onChange={setPermissions}
          />
          <div className="button-row">
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={username.trim() === '' || permissions === 0}
            >
              Add admin
            </Button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function InviteLinks({ channel }: { channel: Channel }): ReactNode {
  const load = useCallback(() => endpoints.channelLinks(channel.id), [channel.id]);
  const links = useResource(load);
  const [created, setCreated] = useState<string>();
  const [error, setError] = useState<string>();
  return (
    <section className="settings-section stack" aria-labelledby="channel-links-heading">
      <h2 id="channel-links-heading">Invite links</h2>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {created === undefined ? null : (
        <Alert tone="success" title="Link created">
          <p>Copy it now; it is not shown again. It expires in 7 days.</p>
          <code className="secret">{created}</code>
        </Alert>
      )}
      <div className="button-row">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void endpoints
              .createChannelLink(channel.id, { expiresInHours: 24 * 7, maxUses: null })
              .then(
                (link) => {
                  setCreated(`${window.location.origin}/channel-invite/${link.token}`);
                  links.reload();
                },
                (caught: unknown) => setError(errorMessage(caught)),
              )
          }
        >
          Create invite link
        </Button>
      </div>
      <ul className="member-list" aria-label="Active channel invite links">
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
                  .revokeChannelLink(channel.id, link.id)
                  .then(links.reload, () => undefined)
              }
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Ownership(props: {
  channel: Channel;
  admins: AdminList | undefined;
  onChanged: () => void;
}): ReactNode {
  const { channel, onChanged } = props;
  const { withStepUp } = useStepUp();
  const navigate = useNavigate();
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string>();
  const candidates = (props.admins?.admins ?? []).slice(1);
  const pending = channel.pendingTransfer;

  async function act(action: () => Promise<unknown>) {
    setError(undefined);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  return (
    <section className="settings-section stack" aria-labelledby="ownership-heading">
      <h2 id="ownership-heading">Ownership</h2>
      {error === undefined ? null : <Alert tone="danger">{error}</Alert>}
      {pending === null ? (
        candidates.length === 0 ? (
          <p className="t-field__hint">
            Make someone an admin to be able to hand the channel over.
          </p>
        ) : (
          <div className="stack">
            <label className="t-field">
              <span className="t-field__label">Hand the channel to</span>
              <select
                className="t-field__input"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Choose an admin</option>
                {candidates.map((admin) => (
                  <option key={admin.userId} value={admin.userId}>
                    @{admin.username}
                  </option>
                ))}
              </select>
            </label>
            <p className="t-field__hint">
              The change takes effect after {OWNERSHIP_COOLDOWN_HOURS} hours; you can cancel it
              until then.
            </p>
            <div className="button-row">
              <Button
                size="sm"
                variant="secondary"
                disabled={target === ''}
                onClick={() =>
                  void act(() =>
                    withStepUp(() => endpoints.requestChannelTransfer(channel.id, target)),
                  )
                }
              >
                Hand over
              </Button>
            </div>
          </div>
        )
      ) : (
        <Alert tone="warning" title="Ownership change pending">
          <p>
            @{pending.toUsername} becomes the owner on{' '}
            {new Date(pending.effectiveAt).toLocaleString()}.
          </p>
          <Button
            size="sm"
            onClick={() => void act(() => endpoints.cancelChannelTransfer(channel.id))}
          >
            Cancel the change
          </Button>
        </Alert>
      )}
      <Button
        variant="danger"
        onClick={() => {
          if (!window.confirm('Delete this channel and all its posts for everyone?')) return;
          void act(async () => {
            if ((await withStepUp(() => endpoints.deleteChannel(channel.id))) !== undefined)
              await navigate('/channels');
          });
        }}
      >
        Delete channel
      </Button>
    </section>
  );
}
