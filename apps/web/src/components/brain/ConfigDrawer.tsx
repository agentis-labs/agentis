import { Drawer } from '../shared/Drawer';
import { BrainConfigWizard } from './BrainConfigWizard';

export function ConfigDrawer({
  open,
  onClose,
  onFinished,
}: {
  open: boolean;
  onClose: () => void;
  onFinished?: () => void;
}) {
  return (
    <Drawer open={open} onClose={onClose} width="brain" title="Brain setup" subtitle="Retrieval and reflection models">
      <BrainConfigWizard
        embedded
        onFinished={() => {
          onFinished?.();
          onClose();
        }}
      />
    </Drawer>
  );
}
