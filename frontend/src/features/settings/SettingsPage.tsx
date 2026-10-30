import { AssetsSection } from './AssetsSection';
import { CategoriesSection } from './CategoriesSection';
import { ModelsSection } from './ModelsSection';
import { ScheduleSection } from './ScheduleSection';
import { SourcesSection } from './SourcesSection';
import { SubjectSection } from './SubjectSection';
import { TelegramSection } from './TelegramSection';

/** Everything here belongs to the signed-in account; other accounts have their own. */
export function SettingsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        <div>
          <h1 className="text-xl font-semibold text-ink">Settings</h1>
          <p className="mt-1 text-sm text-ink-2">
            Your account&apos;s settings: who the news is about, what to search for, which assets to follow, which AI models to use, when to run,
            and where to send notifications.
          </p>
        </div>
        <SubjectSection />
        <AssetsSection />
        <ModelsSection />
        <CategoriesSection />
        <ScheduleSection />
        <TelegramSection />
        <SourcesSection />
      </div>
    </div>
  );
}
