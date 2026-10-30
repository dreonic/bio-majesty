import { LayoutDashboard, Settings, Users } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';
import { Badge } from '../components/ui';
import { cn } from '../lib/cn';
import { ProfileMenu } from './ProfileMenu';
import { useSession } from './session';
import type { RuntimeConfig } from './config';

export function Shell({ config }: { config: RuntimeConfig }) {
  const { demo, admin } = useSession();

  const navClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors',
      isActive ? 'bg-wash text-ink' : 'text-ink-2 hover:bg-wash hover:text-ink',
    );

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-hairline bg-raised px-4">
        <div className="flex items-center gap-2">
          <img src="/favicon.svg" alt="" className="size-7" />
          <span className="font-semibold text-ink">News Accumulator</span>
          {demo ? (
            <Badge className="border-warning/40 bg-warning-wash text-ink" title="Mock mode: fictional sample data, no AWS calls">Demo data</Badge>
          ) : (
            config.stage !== 'prod' && <Badge className="uppercase">{config.stage}</Badge>
          )}
        </div>
        <nav className="flex items-center gap-1" aria-label="Main">
          <NavLink to="/" end className={navClass}>
            <LayoutDashboard className="size-4" aria-hidden /> Dashboard
          </NavLink>
          <NavLink to="/settings" className={navClass}>
            <Settings className="size-4" aria-hidden /> Settings
          </NavLink>
          {admin && (
            <NavLink to="/admin" className={navClass}>
              <Users className="size-4" aria-hidden /> Admin
            </NavLink>
          )}
        </nav>
        <div className="ml-auto flex min-w-0 items-center">
          <ProfileMenu />
        </div>
      </header>
      <main className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
