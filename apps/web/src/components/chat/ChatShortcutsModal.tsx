import * as Dialog from '@radix-ui/react-dialog';
import { X, Keyboard } from 'lucide-react';

interface ChatShortcutsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ChatShortcutsModal({ open, onOpenChange }: ChatShortcutsModalProps) {
  const shortcutGroups = [
    {
      title: 'Navigation & View',
      shortcuts: [
        { keys: ['N'], desc: 'Start a new chat session' },
        { keys: ['H'], desc: 'Toggle history sidebar panel' },
        { keys: ['?'], desc: 'Open this shortcuts helper' },
        { keys: ['Esc'], desc: 'Close dialogs or cancel active actions' },
      ],
    },
    {
      title: 'Composer Inputs',
      shortcuts: [
        { keys: ['Enter'], desc: 'Send message to agent' },
        { keys: ['Shift', 'Enter'], desc: 'Insert a new line' },
        { keys: ['↑'], desc: 'Recall the last sent message' },
        { keys: ['/'], desc: 'Trigger slash commands menu' },
        { keys: ['@'], desc: 'Mention & select specific subagents' },
        { keys: ['#'], desc: 'Attach context files & nodes' },
      ],
    },
  ];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[11000] bg-overlay/80 backdrop-blur-sm transition-opacity duration-200" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[11001] w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-glass-border bg-glass-panel p-6 shadow-modal backdrop-blur-xl focus:outline-none animate-in fade-in slide-in-from-bottom-1 duration-200">
          <div className="flex items-center justify-between border-b border-line pb-4 mb-5">
            <Dialog.Title className="flex items-center gap-2 text-lg font-semibold text-text-primary">
              <Keyboard className="h-5 w-5 text-accent" />
              Keyboard Shortcuts
            </Dialog.Title>
            <Dialog.Close className="rounded-lg p-1.5 text-text-muted hover:bg-surface-3 hover:text-text-primary transition-colors focus:outline-none">
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="space-y-6">
            {shortcutGroups.map((group) => (
              <div key={group.title} className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                  {group.title}
                </h3>
                <div className="grid gap-2">
                  {group.shortcuts.map((shortcut) => (
                    <div
                      key={shortcut.desc}
                      className="flex items-center justify-between py-1.5 border-b border-line/40 last:border-0"
                    >
                      <span className="text-sm text-text-secondary">{shortcut.desc}</span>
                      <div className="flex items-center gap-1">
                        {shortcut.keys.map((key, i) => (
                          <kbd
                            key={i}
                            className="inline-flex min-h-[22px] min-w-[22px] items-center justify-center rounded border border-line-strong bg-surface-2 px-1.5 text-[10px] font-medium font-sans text-text-primary shadow-sm"
                          >
                            {key}
                          </kbd>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 flex justify-end border-t border-line pt-4">
            <Dialog.Close className="rounded-lg bg-surface-3 px-4 py-2 text-sm font-medium text-text-primary hover:bg-line-strong transition-colors focus:outline-none">
              Dismiss
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
