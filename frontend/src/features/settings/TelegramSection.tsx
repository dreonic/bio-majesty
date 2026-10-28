import type { TelegramLinkStartResponse } from '@bio-majesty/shared';
import { CheckCircle2, Copy, ExternalLink, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useToast } from '../../components/toast';
import { Button, Card, SectionTitle, Spinner, Switch } from '../../components/ui';
import { formatDateTime } from '../../lib/format';
import { useSettings, useTelegramLink, useTelegramTest, useTelegramUnlink, useTelegramVerify, useUpdateSettings } from '../../lib/queries';

export function TelegramSection() {
  const settings = useSettings();
  const link = useTelegramLink();
  const verify = useTelegramVerify();
  const unlink = useTelegramUnlink();
  const test = useTelegramTest();
  const update = useUpdateSettings();
  const toast = useToast();
  const [pending, setPending] = useState<TelegramLinkStartResponse | null>(null);
  const tg = settings.data?.telegram;

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

  return (
    <Card>
      <SectionTitle
        title="Telegram notifications"
        description="Get the digest after each run (with a link to the review queue) and alerts when a run fails, in a private chat, a group, or one topic of a group."
      />
      <div className="space-y-4 px-5 py-4">
        {!settings.data ? (
          <Spinner />
        ) : !tg?.configured ? (
          <p className="text-sm text-ink-2">
            The bot is not configured yet. Create a bot with <span className="font-medium text-ink">@BotFather</span> in Telegram and add its token as{' '}
            <code className="rounded bg-wash px-1">TELEGRAM_BOT_TOKEN</code> in the stack's API keys parameter (see README).
          </p>
        ) : tg.linked ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-sm text-ink">
              <CheckCircle2 className="size-4 text-good" aria-hidden /> Connected to <span className="font-medium">{tg.chatTitle}</span>
              {tg.linkedAt && <span className="text-ink-2">since {formatDateTime(tg.linkedAt)}</span>}
            </span>
            <Button size="sm" icon={<Send className="size-4" />} loading={test.isPending} onClick={() => test.mutate(undefined, { onSuccess: () => toast.success('Test message sent'), onError: toast.error })}>
              Send test
            </Button>
            <Button size="sm" variant="danger" loading={unlink.isPending} onClick={() => unlink.mutate(undefined, { onSuccess: () => toast.success('Disconnected'), onError: toast.error })}>
              Disconnect
            </Button>
          </div>
        ) : pending ? (
          <div className="space-y-3 rounded-md bg-accent-wash px-4 py-3 text-sm text-ink">
            <div>
              <p className="font-medium">Private chat</p>
              <p className="mt-0.5">
                Open{' '}
                <a href={pending.deepLink} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium text-accent-strong underline">
                  the bot in Telegram <ExternalLink className="size-3.5" aria-hidden />
                </a>{' '}
                and press <span className="font-medium">Start</span>.
              </p>
            </div>
            <div>
              <p className="font-medium">Group or topic</p>
              <p className="mt-0.5">Add the bot to the group, then send this message in the group, or in the topic that should get your notifications:</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <code className="rounded bg-raised px-2 py-1 text-xs break-all">{pending.groupCommand}</code>
                <Button
                  size="sm"
                  icon={<Copy className="size-4" />}
                  onClick={() =>
                    void navigator.clipboard.writeText(pending.groupCommand).then(
                      () => toast.success('Copied'),
                      () => toast.error('Copy failed: select the text instead'),
                    )
                  }
                >
                  Copy
                </Button>
              </div>
            </div>
            <p className="flex items-center gap-2 text-ink-2">
              <Spinner className="size-4" /> Waiting for Telegram… This page connects automatically (the code works for 10 minutes).
            </p>
          </div>
        ) : (
          <div>
            <Button variant="primary" loading={link.isPending} onClick={() => link.mutate(undefined, { onSuccess: setPending, onError: toast.error })}>
              Connect Telegram
            </Button>
          </div>
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
