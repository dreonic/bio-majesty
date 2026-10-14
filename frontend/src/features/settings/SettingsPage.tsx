import { CategoriesSection } from './CategoriesSection';
import { ModelsSection } from './ModelsSection';
import { ScheduleSection } from './ScheduleSection';
import { SourcesSection } from './SourcesSection';
import { TelegramSection } from './TelegramSection';

export function SettingsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
        <div>
          <h1 className="text-xl font-semibold text-ink">Settings</h1>
          <p className="mt-1 text-sm text-ink-2">What to search for, which AI models to use, when to run, and where to send notifications.</p>
        </div>
        <CategoriesSection />
        <ModelsSection />
        <ScheduleSection />
        <TelegramSection />
        <SourcesSection />
      </div>
    </div>
  );
}
