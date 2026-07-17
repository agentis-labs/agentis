interface BrandMarkProps {
  size?: number;
  variant?: 'mark' | 'wordmark' | 'full';
  className?: string;
  title?: string;
}

const LOGOTYPE_RATIO = 2404 / 246;

export function BrandMark({ size = 24, variant = 'mark', className, title = 'Agentis' }: BrandMarkProps) {
  // The source mark art bleeds to the edge of its frame, whereas the previous
  // hand-drawn glyph carried ~30% breathing room (it filled only 66%×74% of its
  // viewBox). Inset the art to reproduce that footprint so the mark reads at the
  // same visual weight as before instead of oversized/bold next to its neighbours.
  const mark = (
    <BrandAsset asset="mark" width={size} height={size} inset={0.16} title={variant === 'mark' ? title : undefined} />
  );

  if (variant === 'mark') {
    return (
      <span className={className}>
        {mark}
      </span>
    );
  }

  if (variant === 'wordmark') {
    return (
      <BrandAsset
        asset="logotype"
        width={size * LOGOTYPE_RATIO}
        height={size}
        title={title}
        className={className}
      />
    );
  }

  const logotypeHeight = size * 0.42;

  return (
    <span className={['inline-flex items-center gap-1.5', className].filter(Boolean).join(' ')}>
      {mark}
      <BrandAsset asset="logotype" width={logotypeHeight * LOGOTYPE_RATIO} height={logotypeHeight} title={title} />
    </span>
  );
}

function BrandAsset({
  asset,
  width,
  height,
  className,
  title,
  inset = 0,
}: {
  asset: 'mark' | 'logotype';
  width: number;
  height: number;
  className?: string;
  title?: string;
  inset?: number;
}) {
  const pad = inset > 0 ? { padding: `${height * inset}px ${width * inset}px` } : undefined;
  return (
    <span
      role="img"
      aria-label={title ?? 'Agentis'}
      aria-hidden={title ? undefined : true}
      className={['agentis-brand', className].filter(Boolean).join(' ')}
      style={{ width, height, ...pad, boxSizing: 'border-box' }}
    >
      <img
        src={`/brand/agentis-${asset}-light.svg`}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="agentis-brand__asset agentis-brand__asset--light"
      />
      <img
        src={`/brand/agentis-${asset}-dark.svg`}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="agentis-brand__asset agentis-brand__asset--dark"
      />
    </span>
  );
}
