import type { Thread } from "@beyland/tincan-protocol";
import { formatHandle, hue, initials } from "../format.ts";
import { names, photoFor } from "../store.ts";
import { Icon } from "./Icon.tsx";

export function Avatar({
  name,
  group = false,
  members,
  size = 40,
  photo,
}: {
  name: string;
  group?: boolean;
  /** A group's members: two or more show as stacked avatars. */
  members?: readonly string[];
  size?: number;
  /** A data URL of the contact's photo. */
  photo?: string;
}) {
  if (group && members && members.length >= 2) {
    return <StackedAvatar members={members} size={size} />;
  }
  const h = hue(name);
  if (photo && !group) {
    return (
      <img
        class="avatar photo"
        src={photo}
        alt=""
        draggable={false}
        style={{ width: `${size}px`, height: `${size}px` }}
      />
    );
  }
  return (
    <div
      class="avatar"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        fontSize: `${Math.round(size * 0.38)}px`,
        background: `linear-gradient(180deg, hsl(${h} 45% 62%), hsl(${h} 45% 48%))`,
      }}
      aria-hidden="true"
    >
      {group ? <Icon name="people" size={Math.round(size * 0.5)} /> : initials(name)}
    </div>
  );
}

/** Two members' avatars overlapping on a diagonal, standing in for a group. */
function StackedAvatar({ members, size }: { members: readonly string[]; size: number }) {
  const inner = Math.round(size * 0.68);
  const [back, front] = members.slice(0, 2).map((handle) => ({
    name: names.value.get(handle) ?? formatHandle(handle),
    photo: photoFor(handle),
  }));
  return (
    <div
      class="avatar-stack"
      style={{ width: `${size}px`, height: `${size}px` }}
      aria-hidden="true"
    >
      <span class="avatar-stack-back">
        <Avatar name={back!.name} photo={back!.photo} size={inner} />
      </span>
      <span class="avatar-stack-front">
        <Avatar name={front!.name} photo={front!.photo} size={inner} />
      </span>
    </div>
  );
}

/** A conversation's avatar: the contact's photo, or a group's first members stacked. */
export function ThreadAvatar({ thread, size }: { thread: Thread; size?: number }) {
  return (
    <Avatar
      name={thread.title}
      group={thread.kind === "group"}
      members={thread.kind === "group" ? thread.members : undefined}
      size={size}
      photo={thread.kind === "group" ? undefined : photoFor(thread.key)}
    />
  );
}
