import { MAX_TELEGRAM_CONNECTIONS, type TelegramLinkKind, type TelegramLinkStartResponse } from '@bio-majesty/shared';
import { Copy, ExternalLink, MessageCircle, Send, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useToast } from '../../components/toast';
import { Badge, Button, Card, SectionTitle, Spinner, Switch } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { useSettings, useTelegramDisconnect, useTelegramLink, useTelegramTest, useTelegramVerify, useUpdateSettings } from '../../lib/queries';

export function TelegramSection() {
  const settings = useSettings();
  const link = useTelegramLink();
  const verify = useTelegramVerify();
  const disconnect = useTelegramDisconnect();
  const test = useTelegramTest();
  const update = useUpdateSettings();
  const toast = useToast();
  const [pending, setPending] = useState<TelegramLinkStartResponse | null>(null);
  const tg = settings.data?.telegram;
  const connections = tg?.connections ?? [];

  // Poll until the /start message reaches the bot, for as long as the code is valid (10 minutes).
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      if (Date.now() > Date.parse(pending.expiresAt)) {
        clearInterval(timer);
        setPending(null);
        toast.error('Linking timed out. Try again.');
        return;
      }
      verify.mutate(pending.code, {
        onSuccess: (res) => {
          if (res.linked) {
            clearInterval(timer);
            setPending(null);
            toast.success(`Connected to ${res.chatTitle ?? 'Telegram'}`);
          }
        },
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [pending?.code]);

  const start = (kind: TelegramLinkKind) => link.mutate(kind, { onSuccess: setPending, onError: toast.error });

  return (
    <Card>
      <SectionTitle
        title="Telegram notifications"
        description="Get the digest after each run (with a link to the review queue) and alerts when a run fails. Connect as many chats as you like: a private chat, groups, or single topics of a group."
      />
      <div className="space-y-4 px-5 py-4">
        {!settings.data ? (
          <Spinner />
        ) : !tg?.configured ? (
          <p className="text-sm text-ink-2">
            The bot is not configured yet. Create a bot with <span className="font-medium text-ink">@BotFather</span> in Telegram and add its token as{' '}
            <code className="rounded bg-wash px-1">TELEGRAM_BOT_TOKEN</code> in the stack's API keys parameter (see README).
          </p>
        ) : (
          <>
            {connections.length > 0 && (
              <ul className="divide-y divide-hairline rounded-md border border-hairline">
                {connections.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                    {c.kind === 'group' ? <Users className="size-4 text-ink-2" aria-hidden /> : <MessageCircle className="size-4 text-ink-2" aria-hidden />}
                    <span className="min-w-0 flex-1 text-sm text-ink">
                      <span className="font-medium">{c.chatTitle}</span> <span className="text-ink-2">since {formatDateTime(c.linkedAt)}</span>
                    </span>
                    <Badge>{c.kind === 'group' ? 'Group' : 'Private chat'}</Badge>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Send className="size-4" />}
                      loading={test.isPending && test.variables === c.id}
                      onClick={() => test.mutate(c.id, { onSuccess: () => toast.success(`Test message sent to ${c.chatTitle}`), onError: toast.error })}
                    >
                      Send test
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<X className="size-4" />}
                      loading={disconnect.isPending && disconnect.variables === c.id}
                      onClick={() => disconnect.mutate(c.id, { onSuccess: () => toast.success(`Disconnected ${c.chatTitle}`), onError: toast.error })}
                    >
                      Disconnect
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {pending ? (
              <div className="space-y-2 rounded-md bg-accent-wash px-4 py-3 text-sm text-ink">
                {pending.kind === 'private' && pending.deepLink ? (
                  <p>
                    Open{' '}
                    <a href={pending.deepLink} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-accent-strong underline">
                      the bot in Telegram <ExternalLink className="size-3.5" aria-hidden />
                    </a>{' '}
                    on the phone or computer that should get notifications, and press <span className="font-medium">Start</span>.
                  </p>
                ) : (
                  pending.groupCommand && (
                    <>
                      <p>Add the bot to the group, then send this message in the group, or in the topic that should get your notifications:</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="rounded bg-raised px-2 py-1 text-xs break-all">{pending.groupCommand}</code>
                        <Button
                          size="sm"
                          icon={<Copy className="size-4" />}
                          onClick={() =>
                            void navigator.clipboard.writeText(pending.groupCommand!).then(
                              () => toast.success('Copied'),
                              () => toast.error('Copy failed: select the text instead'),
                            )
                          }
                        >
                          Copy
                        </Button>
                      </div>
                    </>
                  )
                )}
                <div className="flex flex-wrap items-center gap-3 text-ink-2">
                  <span className="flex items-center gap-2">
                    <Spinner className="size-4" /> Waiting for Telegram… This page connects automatically (the code works for 10 minutes).
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : connections.length >= MAX_TELEGRAM_CONNECTIONS ? (
              <p className="text-sm text-ink-2">That's the maximum of {MAX_TELEGRAM_CONNECTIONS} connections. Disconnect one to add another.</p>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink">{connections.length ? 'Add another:' : 'Connect:'}</span>
                <Button variant="primary" icon={<MessageCircle className="size-4" />} loading={link.isPending && link.variables === 'private'} onClick={() => start('private')}>
                  Private chat
                </Button>
                <Button variant="primary" icon={<Users className="size-4" />} loading={link.isPending && link.variables === 'group'} onClick={() => start('group')}>
                  Group or topic
                </Button>
              </div>
            )}
          </>
        )}
        {settings.data && (
          <Switch
            checked={settings.data.notifications.notifyWhenEmpty}
            onChange={(v) => update.mutate({ notifications: { notifyWhenEmpty: v } }, { onError: toast.error })}
            label="Also notify when a daily run finds nothing new"
          />
        )}
      </div>
    </Card>
  );
}
