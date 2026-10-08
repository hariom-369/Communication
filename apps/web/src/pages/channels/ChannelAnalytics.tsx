import { Alert, Skeleton } from '@tessera/ui';
import { useCallback, type ReactNode } from 'react';

import { endpoints } from '../../api/endpoints.js';
import { useResource } from '../../lib/use-resource.js';

import { subscriberLabel } from './shared.js';

const number = new Intl.NumberFormat();

/**
 * Aggregate analytics only (docs/channels.md §5): unique viewers per day and per post, joins and
 * leaves. Nothing identifies which subscriber viewed what.
 */
export function ChannelAnalytics({ channelId }: { channelId: string }): ReactNode {
  const load = useCallback(() => endpoints.channelAnalytics(channelId), [channelId]);
  const analytics = useResource(load);
  if (analytics.error !== undefined) return <Alert tone="danger">{analytics.error}</Alert>;
  const data = analytics.data;
  if (data === undefined) return <Skeleton height="8rem" shape="tile" />;
  const recent = data.days.slice(-14).reverse();
  return (
    <div className="stack">
      <p>
        <strong>{subscriberLabel(data.subscriberCount)}</strong>. Views count each person once per
        post per day; Tessera does not show who viewed what.
      </p>
      <section className="stack" aria-labelledby="post-stats-heading">
        <h2 id="post-stats-heading">Recent posts</h2>
        {data.posts.length === 0 ? (
          <p className="empty">No published posts yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Post</th>
                  <th scope="col">Views</th>
                  <th scope="col">Reactions</th>
                  <th scope="col">Comments</th>
                </tr>
              </thead>
              <tbody>
                {data.posts.map((post) => (
                  <tr key={post.id}>
                    <th scope="row">{post.excerpt === '' ? 'Poll' : post.excerpt}</th>
                    <td>{number.format(post.views)}</td>
                    <td>{number.format(post.reactions)}</td>
                    <td>{number.format(post.comments)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="stack" aria-labelledby="daily-stats-heading">
        <h2 id="daily-stats-heading">Last 14 days</h2>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Views</th>
                <th scope="col">Joined</th>
                <th scope="col">Left</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((day) => (
                <tr key={day.day}>
                  <th scope="row">
                    {new Date(`${day.day}T00:00:00Z`).toLocaleDateString(undefined, {
                      timeZone: 'UTC',
                    })}
                  </th>
                  <td>{number.format(day.views)}</td>
                  <td>{number.format(day.joined)}</td>
                  <td>{number.format(day.left)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
