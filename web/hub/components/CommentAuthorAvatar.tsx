import { cn } from '@/lib/cn';

interface CommentAuthorAvatarProps {
  // A stable seed (e.g. comment key or a fixed name) used to pick the avatar.
  seed: string;
  className?: string;
}

// pdiff: a round badge with the author's first letter. DiffsHub shows sample
// avatar images, which pdiff does not ship.
export function CommentAuthorAvatar({ seed, className }: CommentAuthorAvatarProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'flex size-8 shrink-0 select-none items-center justify-center self-start rounded-full bg-blue-500 text-[13px] font-semibold text-white',
        className
      )}
    >
      {(seed.trim()[0] ?? '?').toUpperCase()}
    </div>
  );
}
