import { describe, expect, it, vi } from "vite-plus/test";
import { ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_RUNTIME_MODE } from "../types";
import { closestCenter, type CollisionDetection } from "@dnd-kit/core";
import { verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import {
  createSidebarCollisionDetection,
  createSidebarSortingStrategy,
  restrictBelowSidebarLabel,
} from "./Sidebar.drag";
import {
  resolveSidebarDropTarget,
  resolveSidebarDropVerb,
  isSidebarDragSourceValid,
  projectSidebarActiveDropOrder,
  constrainSidebarDropTarget,
  planSidebarThreadDrop,
  applySidebarThreadDrop,
  orderSidebarThreadsByStatus,
  sidebarActiveGroup,
  sortThreadsForSidebar,
  type SidebarActiveGroup,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
} from "./Sidebar.logic";

const thread = (key: string, section: SidebarSection): SidebarListItem => ({
  kind: "thread",
  key,
  section,
});
const marker = (marker: SidebarListMarker): SidebarListItem => ({ kind: "marker", marker });
const pinnedHeader = marker("pinned-header");
const divider = marker("pinned-divider");
const settledHeader = marker("settled-header");
const stationary = { x: 0, y: 0, scaleX: 1, scaleY: 1 };

function layout(
  items: readonly SidebarListItem[],
  active: string,
  over: string,
  scale = 1,
  cardHeight = 82,
) {
  let top = 100;
  const rects = items.map((item) => {
    const height =
      item.kind === "thread"
        ? (item.section === "pinned" || item.section === "active" ? cardHeight : 36) * scale
        : item.marker === "pinned-header" || item.marker === "pinned-divider"
          ? 0
          : (item.marker.endsWith("placeholder") ? 0 : 32) * scale;
    const rect = { top, height, bottom: top + height, left: 0, right: 260, width: 260 };
    top += height + 1;
    return rect;
  });
  const activeIndex = items.findIndex((item) => sidebarListItemId(item) === active);
  return {
    activeIndex,
    overIndex: items.findIndex((item) => sidebarListItemId(item) === over),
    activeNodeRect: rects[activeIndex]!,
    rects,
    index: 0,
  } satisfies Parameters<SortingStrategy>[0];
}

function preview(
  input: Parameters<typeof createSidebarSortingStrategy>[0],
  active: string,
  over: string,
  scale = 1,
) {
  const strategy = createSidebarSortingStrategy(input);
  const args = layout(input.items, active, over, scale);
  return new Map(
    input.items.map((item, index) => [sidebarListItemId(item), strategy({ ...args, index })]),
  );
}

describe("sidebar collision detection", () => {
  function collisionArgs(blockedAboveSource = false) {
    const rows = [thread("source", "active"), thread("blocked", "active")];
    const items = [
      pinnedHeader,
      divider,
      ...(blockedAboveSource ? rows.toReversed() : rows),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const { rects, activeIndex, overIndex } = layout(items, "source", "blocked");
    const collisionRect = rects[overIndex]!;
    return {
      active: {
        id: "source",
        data: { current: {} },
        rect: { current: { initial: rects[activeIndex]!, translated: collisionRect } },
      },
      collisionRect,
      droppableRects: new Map(items.map((item, index) => [sidebarListItemId(item), rects[index]!])),
      droppableContainers: items.map((item, index) => ({
        id: sidebarListItemId(item),
        key: sidebarListItemId(item),
        disabled: false,
        data: { current: {} },
        node: { current: null },
        rect: { current: rects[index]! },
      })),
      pointerCoordinates: null,
    } satisfies Parameters<CollisionDetection>[0];
  }

  it.each([
    [false, sidebarMarkerId("settled-header")],
    [true, sidebarMarkerId("pinned-divider")],
  ] as const)(
    "rejects unsupported Active instead of selecting %s / %s",
    (blockedAboveSource, nearbyTarget) => {
      const args = collisionArgs(blockedAboveSource);
      const detector = createSidebarCollisionDetection((id) => id !== "blocked");
      const filtered = closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (container) => container.id !== "blocked",
        ),
      });
      expect(filtered[0]?.id).toBe(nearbyTarget);
      expect(detector(args).map((collision) => collision.id)).toEqual(["source"]);
    },
  );

  it("selects the nearest supported target", () => {
    const detector = createSidebarCollisionDetection(() => true);
    expect(detector(collisionArgs())[0]?.id).toBe("blocked");
  });

  it.each([
    { sourceSection: "active", pins: 0 },
    { sourceSection: "active", pins: 1 },
    { sourceSection: "pinned", pins: 1 },
    { sourceSection: "settled", pins: 1 },
  ] as const)(
    "switches on crossing the divider row from $sourceSection with $pins pins",
    ({ sourceSection, pins }) => {
      const items = [
        pinnedHeader,
        ...(pins ? [thread("p", "pinned")] : []),
        ...(sourceSection === "pinned" ? [thread("source", "pinned")] : []),
        divider,
        thread("a", "active"),
        ...(sourceSection === "active" ? [thread("source", "active")] : []),
        settledHeader,
        ...(sourceSection === "settled" ? [thread("source", "settled")] : []),
      ];
      const { rects, activeIndex } = layout(items, "source", "a");
      const sourceRect = rects[activeIndex]!;
      let boundaryTop = 300;
      const boundaryNode = {
        querySelector: () => ({
          getBoundingClientRect: () => ({
            top: boundaryTop,
            bottom: boundaryTop + 16,
            left: 0,
            right: 260,
          }),
        }),
      } as unknown as HTMLElement;
      const detector = createSidebarCollisionDetection(() => true, {
        items,
        activationY: sourceSection === "pinned" ? 200 : 600,
      });
      const at = (center: number) => {
        const collisionRect = {
          ...sourceRect,
          top: center - sourceRect.height / 2,
          bottom: center + sourceRect.height / 2,
        };
        const args = {
          ...collisionArgs(),
          active: {
            id: "source",
            data: { current: {} },
            rect: { current: { initial: sourceRect, translated: collisionRect } },
          },
          collisionRect,
          pointerCoordinates: { x: 130, y: center },
          droppableRects: new Map(
            items.map((item, index) => [sidebarListItemId(item), rects[index]!]),
          ),
          droppableContainers: items.map((item, index) => ({
            id: sidebarListItemId(item),
            key: sidebarListItemId(item),
            disabled: false,
            data: { current: {} },
            node: {
              current:
                item === divider
                  ? boundaryNode
                  : item === settledHeader
                    ? ({ getBoundingClientRect: () => ({ top: 600 }) } as unknown as HTMLElement)
                    : null,
            },
            rect: { current: rects[index]! },
          })),
        };
        const over = detector(args)[0];
        return over ? resolveSidebarDropTarget(items, "source", String(over.id))?.section : null;
      };
      expect(at(330)).toBe("active");
      expect(at(317)).toBe("active");
      expect(at(316)).toBe("pinned");
      // The preview moves the divider; a stationary pointer must not undo the drop target.
      boundaryTop = 400;
      expect(at(316)).toBe("pinned");
      expect(at(399)).toBe("pinned");
      expect(at(400)).toBe("active");
      boundaryTop = 300;
      expect(at(400)).toBe("active");
      expect(at(317)).toBe("active");
      expect(at(316)).toBe("pinned");
    },
  );

  it("returns no collision if an unsupported target has no source fallback", () => {
    const args = collisionArgs();
    const detector = createSidebarCollisionDetection(() => false);
    expect(
      detector({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (container) => container.id !== "source",
        ),
      }),
    ).toEqual([]);
  });

  it("validates each hovered target once and always allows returning to the source", () => {
    const args = collisionArgs();
    const isValid = vi.fn((id: string) => id !== "blocked");
    const detector = createSidebarCollisionDetection(isValid);
    expect(detector(args)[0]?.id).toBe("source");
    expect(
      detector({
        ...args,
        collisionRect: {
          ...args.collisionRect,
          top: args.collisionRect.top + 3,
          bottom: args.collisionRect.bottom + 3,
        },
      })[0]?.id,
    ).toBe("source");
    expect(detector({ ...args, collisionRect: args.droppableRects.get("source")! })[0]?.id).toBe(
      "source",
    );
    expect(
      detector({
        ...args,
        collisionRect: args.droppableRects.get(sidebarMarkerId("settled-placeholder"))!,
      })[0]?.id,
    ).toBe(sidebarMarkerId("settled-placeholder"));
    expect(isValid.mock.calls).toEqual([["blocked"], [sidebarMarkerId("settled-placeholder")]]);
  });
});

describe("sidebar drag projection", () => {
  it.each([
    ["a2", "a1"],
    ["p", "a1"],
    ["s", sidebarMarkerId("pinned-header")],
    ["z", sidebarMarkerId("settled-header")],
  ])("restores every row and marker when dragging %s out after hovering %s", (active, over) => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      marker("active-placeholder"),
      thread("a1", "active"),
      thread("a2", "active"),
      marker("snoozed-header"),
      thread("z", "snoozed"),
      settledHeader,
      marker("settled-placeholder"),
      thread("s", "settled"),
    ];
    const input = {
      items,
      settledOrder: ["z", "s"],
      settledExpanded: true,
      boundaryLabelHeight: 24,
      snoozedThreadCount: 1,
    };
    const reordered = preview(input, active, over);
    expect([...reordered.values()].some((transform) => transform?.y !== 0)).toBe(true);

    const restored = preview({ ...input, enabled: false }, active, over);
    for (const transform of restored.values()) expect(transform).toEqual(stationary);

    // Returning to the sidebar resumes the same live reorder preview.
    expect(preview({ ...input, enabled: true }, active, over)).toEqual(reordered);
  });

  it.each([
    ["a1", "a2"],
    ["a1", sidebarMarkerId("settled-header")],
    ["z", "a2"],
  ])("keeps sparse shelves at the bottom when dragging %s over %s", (active, over) => {
    const items = [
      pinnedHeader,
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      marker("snoozed-header"),
      thread("z", "snoozed"),
      settledHeader,
      thread("s", "settled"),
    ];
    const strategy = createSidebarSortingStrategy({
      items,
      settledOrder: over === sidebarMarkerId("settled-header") ? ["a1", "s"] : ["s"],
      settledExpanded: true,
      boundaryLabelHeight: 24,
      snoozedThreadCount: 1,
    });
    const args = layout(items, active, over);
    for (const rect of args.rects.slice(4)) {
      rect.top += 400;
      rect.bottom += 400;
    }
    const lastIndex = items.length - 1;
    expect(strategy({ ...args, index: lastIndex })).toEqual(stationary);
  });

  const pinned = [
    pinnedHeader,
    thread("p1", "pinned"),
    thread("p2", "pinned"),
    divider,
    thread("a1", "active"),
    settledHeader,
    thread("s1", "settled"),
  ];

  it.each([
    ["p1", "p2"],
    ["p2", "p1"],
  ])("preserves existing pinned transforms from %s to %s", (active, over) => {
    const strategy = createSidebarSortingStrategy({
      items: pinned,
      settledOrder: [],
      settledExpanded: true,
    });
    const args = layout(pinned, active, over);
    // dnd-kit moves the lifted row by the pointer delta, so only peers matter.
    for (let index = 0; index < pinned.length; index += 1) {
      if (index === args.activeIndex) continue;
      expect(strategy({ ...args, index })).toEqual(verticalListSortingStrategy({ ...args, index }));
    }
  });

  it("keeps the pinned header above the gap when a lower pin moves to the top", () => {
    const result = preview(
      { items: pinned, settledOrder: [], settledExpanded: true },
      "p2",
      sidebarMarkerId("pinned-header"),
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get("p1")).toEqual({ ...stationary, y: 83 });
    expect(result.get(sidebarMarkerId("pinned-divider"))).toEqual(stationary);
    expect(result.get("a1")).toEqual(stationary);
  });

  it.each([
    ["a1", "a2"],
    ["a2", "a1"],
  ])("uses pinned dragging behavior for Active from %s to %s", (active, over) => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      settledHeader,
      thread("s", "settled"),
    ];
    const strategy = createSidebarSortingStrategy({
      items,
      settledOrder: [],
      settledExpanded: true,
    });
    const args = layout(items, active, over);
    for (let index = 0; index < items.length; index += 1) {
      if (index === args.activeIndex) continue;
      expect(strategy({ ...args, index })).toEqual(verticalListSortingStrategy({ ...args, index }));
    }
  });

  it("preserves settled order while opening the zero-height Active target", () => {
    const items = [
      pinnedHeader,
      divider,
      marker("active-placeholder"),
      settledHeader,
      thread("first", "settled"),
      thread("second", "settled"),
    ];
    const result = preview(
      { items, settledOrder: ["first", "second"], settledExpanded: true },
      "second",
      "first",
    );
    expect(result.get(sidebarMarkerId("active-placeholder"))).toEqual(stationary);
    expect(result.get(sidebarMarkerId("settled-header"))).toEqual({ ...stationary, y: 36 });
    expect(result.get("first")).toEqual({ ...stationary, y: 36 });
    expect(result.get("second")).toEqual(stationary);
  });

  it.each([
    [sidebarMarkerId("pinned-divider"), 0, 0],
    ["a1", -83, 0],
    ["a2", -83, -83],
  ] as const)(
    "opens the active pointer slot over %s without adding an empty pinned row",
    (over, a1Offset, a2Offset) => {
      const items = [
        pinnedHeader,
        thread("p", "pinned"),
        divider,
        thread("a1", "active"),
        thread("a2", "active"),
        settledHeader,
        thread("s", "settled"),
      ];
      const result = preview({ items, settledOrder: [], settledExpanded: true }, "p", over);
      expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
      expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(-83);
      expect(result.get("a1")?.y).toBe(a1Offset);
      expect(result.get("a2")?.y).toBe(a2Offset);
      expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(0);
    },
  );

  it("opens label space below each pinned boundary while dragging", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      settledHeader,
      thread("s", "settled"),
    ];
    // Reorder inside active: the header gap shifts every row, the divider
    // gap shifts the active rows and the shelf below by a second label.
    const result = preview(
      { items, settledOrder: [], settledExpanded: true, boundaryLabelHeight: 16 },
      "a2",
      "a1",
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get("p")?.y).toBe(16);
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(16);
    expect(result.get("a2")).toEqual(stationary);
    expect(result.get("a1")?.y).toBe(32 + 83);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(32);
    expect(result.get("s")?.y).toBe(32);
  });

  it.each(["s1", "missing-target"])(
    "keeps label clearance when a settled drag is over %s",
    (over) => {
      const items = [
        pinnedHeader,
        thread("p", "pinned"),
        divider,
        thread("a", "active"),
        settledHeader,
        thread("s1", "settled"),
        thread("s2", "settled"),
      ];
      const result = preview(
        {
          items,
          settledOrder: ["s1", "s2"],
          settledExpanded: true,
          boundaryLabelHeight: 24,
        },
        "s2",
        over,
      );
      expect(result.get("p")?.y).toBe(24);
      expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(24);
      expect(result.get("a")?.y).toBe(48);
      expect(result.get("s1")?.y).toBe(48);
      expect(result.get("s2")).toEqual(stationary);
    },
  );

  it("stacks the labels with their gaps when the pinned section is empty", () => {
    const items = [
      pinnedHeader,
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      settledHeader,
      thread("s", "settled"),
    ];
    const result = preview(
      { items, settledOrder: [], settledExpanded: true, boundaryLabelHeight: 16 },
      "a2",
      "a1",
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(16);
    expect(result.get("a1")?.y).toBe(32 + 83);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(32);
  });

  it("scales the label space with the measured root scale", () => {
    const items = [pinnedHeader, thread("p", "pinned"), divider, thread("a1", "active")];
    const result = preview(
      { items, settledOrder: [], settledExpanded: true, boundaryLabelHeight: 16 },
      "a1",
      "p",
      2,
    );
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(32 + 165);
  });

  it("keeps the pinned header above the first arriving pin", () => {
    const items = [
      pinnedHeader,
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      settledHeader,
      thread("s", "settled"),
    ];
    const result = preview(
      { items, settledOrder: [], settledExpanded: true },
      "a2",
      sidebarMarkerId("pinned-header"),
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(83);
    expect(result.get("a1")?.y).toBe(83);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(0);
  });

  it.each([
    ["p", -83, -1],
    ["s", 0, 82],
  ] as const)(
    "replaces the empty Active target when %s enters",
    (active, dividerOffset, settledOffset) => {
      const items = [
        pinnedHeader,
        thread("p", "pinned"),
        divider,
        marker("active-placeholder"),
        settledHeader,
        thread("s", "settled"),
      ];
      const result = preview(
        { items, settledOrder: [], settledExpanded: true },
        active,
        sidebarMarkerId("active-placeholder"),
      );
      expect(result.get(sidebarMarkerId("active-placeholder"))?.scaleY).toBe(0);
      expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(dividerOffset);
      expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(settledOffset);
    },
  );

  it("uses the canonical settled rank and the destination's slim height", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      thread("s1", "settled"),
      thread("s2", "settled"),
    ];
    const result = preview(
      { items, settledOrder: ["s1", "a", "s2"], settledExpanded: true },
      "a",
      "s2",
    );
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(-46);
    expect(result.get("s1")?.y).toBe(-46);
    expect(result.get("s2")?.y).toBe(-9);
  });

  it.each([
    ["a1", 83],
    ["a2", 0],
  ] as const)(
    "reserves a full card at the pointer slot over %s when a slim row enters Active",
    (over, firstOffset) => {
      const items = [
        pinnedHeader,
        thread("p", "pinned"),
        divider,
        thread("a1", "active"),
        thread("a2", "active"),
        settledHeader,
        thread("s", "settled"),
      ];
      const result = preview({ items, settledOrder: [], settledExpanded: true }, "s", over);
      expect(result.get("a1")?.y).toBe(firstOffset);
      expect(result.get("a2")?.y).toBe(83);
      expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(83);
    },
  );

  it("removes the snoozed header when its last row leaves", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      marker("snoozed-header"),
      thread("z", "snoozed"),
      settledHeader,
      thread("s", "settled"),
    ];
    const result = preview({ items, settledOrder: [], settledExpanded: true }, "z", "a");
    expect(result.get(sidebarMarkerId("snoozed-header"))?.scaleY).toBe(0);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(13);
    expect(result.get("s")?.y).toBe(13);
  });

  it("keeps a collapsed settled target without inserting a hidden row", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const result = preview(
      { items, settledOrder: [], settledExpanded: false },
      "a2",
      sidebarMarkerId("settled-placeholder"),
    );
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(-83);
    expect(result.get(sidebarMarkerId("settled-placeholder"))).toEqual({ ...stationary, y: -83 });
  });

  it("preserves a collapsed snoozed header while another section changes", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      marker("snoozed-header"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const result = preview(
      { items, settledOrder: [], settledExpanded: false },
      "a",
      sidebarMarkerId("settled-placeholder"),
    );
    expect(result.get(sidebarMarkerId("snoozed-header"))).toEqual({ ...stationary, y: -46 });
  });

  it("previews a time-ordered inbox drop at its time slot, above the Working shelf", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a1", "active"),
      thread("a2", "active"),
      marker("working-header"),
      thread("w", "working"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const input = { items, settledOrder: [], settledExpanded: false };
    // By pointer, the unpinned row lands between a1 and a2.
    expect(preview(input, "p", "a1").get("a2")?.y).toBe(0);
    // By time, it lands below a2, and the shelf does not move.
    const byTime = preview({ ...input, activeOrder: ["a1", "a2", "p"] }, "p", "a1");
    expect(byTime.get("a2")?.y).toBe(-83);
    expect(byTime.get(sidebarMarkerId("working-header"))).toEqual(stationary);
    expect(byTime.get("w")).toEqual(stationary);
  });

  it("derives missing card geometry from the measured root scale", () => {
    const items = [
      pinnedHeader,
      divider,
      marker("active-placeholder"),
      settledHeader,
      thread("s", "settled"),
    ];
    const result = preview(
      { items, settledOrder: [], settledExpanded: true },
      "s",
      sidebarMarkerId("pinned-header"),
      0.75,
    );
    expect(result.get(sidebarMarkerId("pinned-header"))).toEqual(stationary);
    expect(result.get(sidebarMarkerId("pinned-divider"))?.y).toBe(62.5);
    expect(result.get(sidebarMarkerId("active-placeholder"))?.y).toBe(62.5);
  });

  it("updates the projection when the target or measured geometry changes", () => {
    const strategy = createSidebarSortingStrategy({
      items: pinned,
      settledOrder: [],
      settledExpanded: true,
    });
    const args = layout(pinned, "p1", "p1");
    expect(strategy({ ...args, index: 2 })?.y).toBe(0);
    expect(strategy({ ...args, index: 2, overIndex: 4 })?.y).toBe(-83);
    const smaller = layout(pinned, "p1", "a1", 0.75);
    expect(strategy({ ...smaller, index: 2 })?.y).toBe(-62.5);
  });

  it.each(["active", "settled"] as const)(
    "reveals the mounted empty %s target when its last row leaves and hides it on return",
    (section) => {
      const items = [
        pinnedHeader,
        thread("p", "pinned"),
        divider,
        marker("active-placeholder"),
        thread("a", "active"),
        settledHeader,
        marker("settled-placeholder"),
        thread("s", "settled"),
      ];
      const active = section === "active" ? "a" : "s";
      const input = { items, settledOrder: ["s"], settledExpanded: true };
      const placeholderId = sidebarMarkerId(`${section}-placeholder`);
      const resting = preview(input, active, active);
      expect(resting.get(placeholderId)?.scaleY).toBe(0);
      const leaving = preview(input, active, sidebarMarkerId("pinned-header"));
      expect(leaving.get(placeholderId)?.scaleY).toBe(1);
      const returning = preview(input, active, active);
      expect(returning.get(placeholderId)?.scaleY).toBe(0);
    },
  );

  it("uses shelf height for empty target sizing when card height differs from its default", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const strategy = createSidebarSortingStrategy({
      items,
      settledOrder: [],
      settledExpanded: false,
    });
    const args = layout(items, "a", sidebarMarkerId("settled-placeholder"), 1, 78);
    expect(strategy({ ...args, index: 4 })?.y).toBe(-42);
  });

  it("keeps the route row visible after a settled drop pushes it beyond the page", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      thread("s", "settled"),
    ];
    const input = {
      items,
      settledOrder: ["a", "s", "hidden"],
      settledExpanded: true,
      settledVisibleCount: 1,
    };
    const withRoute = preview({ ...input, routeThreadKey: "s" }, "a", "s");
    const withoutRoute = preview(input, "a", "s");
    expect(withRoute.get("s")).toEqual({ ...stationary, y: -9 });
    expect(withoutRoute.get("s")?.scaleY).toBe(0);
  });

  it("reserves the next page row when a visible settled thread leaves", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      thread("s1", "settled"),
      thread("route", "settled"),
    ];
    const result = preview(
      {
        items,
        settledOrder: ["s1", "hidden", "route"],
        settledExpanded: true,
        settledVisibleCount: 1,
        routeThreadKey: "route",
      },
      "s1",
      "a",
    );
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(83);
    expect(result.get("route")?.y).toBe(83);
  });

  it("keeps the dropped route thread visible in a collapsed settled shelf", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      settledHeader,
      marker("settled-placeholder"),
    ];
    const result = preview(
      {
        items,
        settledOrder: ["a", "hidden"],
        settledExpanded: false,
        settledVisibleCount: 1,
        routeThreadKey: "a",
      },
      "a",
      sidebarMarkerId("settled-placeholder"),
    );
    expect(result.get(sidebarMarkerId("settled-placeholder"))?.scaleY).toBe(0);
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(-46);
  });

  it("preserves hidden snoozed membership when the only rendered route row leaves", () => {
    const items = [
      pinnedHeader,
      thread("p", "pinned"),
      divider,
      thread("a", "active"),
      marker("snoozed-header"),
      thread("z", "snoozed"),
      settledHeader,
      thread("s", "settled"),
    ];
    const result = preview(
      {
        items,
        settledOrder: ["s"],
        settledExpanded: true,
        snoozedThreadCount: 2,
      },
      "z",
      "a",
    );
    expect(result.get(sidebarMarkerId("snoozed-header"))).toEqual({ ...stationary, y: 83 });
    expect(result.get(sidebarMarkerId("settled-header"))?.y).toBe(46);
  });
});

describe("lifted card clearance", () => {
  const rect = (top: number, height: number) => ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 260,
    width: 260,
  });
  const apply = (cardTop: number, cardHeight: number, y: number, listTop = 136, offset = 32) =>
    restrictBelowSidebarLabel(
      {
        transform: { ...stationary, y },
        containerNodeRect: rect(listTop, 500),
        draggingNodeRect: rect(cardTop, cardHeight),
        activatorEvent: null,
        active: null,
        activeNodeRect: null,
        over: null,
        overlayNodeRect: null,
        scrollableAncestors: [],
        scrollableAncestorRects: [],
        windowRect: null,
      },
      offset,
    );

  it.each([36, 82])("keeps a %ipx row below empty Pins even past the top edge", (height) => {
    for (const pointerY of [150, 136, 100, 0]) {
      const transform = apply(511, height, pointerY - 529);
      expect(511 + transform.y).toBe(168);
    }
  });

  it("preserves pointer movement below the label", () => {
    expect(apply(511, 36, -200).y).toBe(-200);
  });

  it("follows the list when it scrolls and includes content preceding Pins", () => {
    expect(511 + apply(511, 36, -500, 96).y).toBe(128);
    expect(511 + apply(511, 36, -500, 136, 114).y).toBe(250);
  });
});

describe("status-constrained sidebar drops", () => {
  const activeOrder = ["input", "work1", "work2", "failed", "done1", "done2"];
  const groups = new Map<string, SidebarActiveGroup>([
    ["input", "waiting"],
    ["work1", "working"],
    ["work2", "working"],
    ["failed", "failed"],
    ["done1", "ended"],
    ["done2", "ended"],
  ]);
  const items = [
    pinnedHeader,
    divider,
    ...activeOrder.map((key) => thread(key, "active")),
    settledHeader,
  ];
  const resolve = (activeKey: string, overId: string) =>
    constrainSidebarDropTarget({
      target: resolveSidebarDropTarget(items, activeKey, overId),
      activeKey,
      activeSection: "active",
      activeOrder,
      groups,
      enteringActiveOrder: [],
    });
  const plan = (
    activeKey: string,
    target: NonNullable<ReturnType<typeof resolve>>,
    activeSection: SidebarSection = "active",
  ) =>
    planSidebarThreadDrop({
      activeKey,
      activeSection,
      target,
      pinnedOrder: [],
      pinnedKeysById: new Map(),
      activeOrder,
      activeKeysById: new Map([["hidden", "V"]]),
      activeReorderableKeys: new Set(["work1", "work2"]),
    });

  it("persists a within-group reorder without rewriting other groups or hidden keys", () => {
    const target = resolve("work2", "work1")!;
    const result = plan("work2", target);
    expect(result.kind).toBe("move-active");
    if (result.kind !== "move-active") return;
    expect(result.order).toEqual(["input", "work2", "work1", "failed", "done1", "done2"]);
    expect(result.assignments.map(({ id }) => id)).toEqual(["work2", "work1"]);
    expect(result.assignments.every(({ orderKey }) => orderKey !== "V")).toBe(true);
    const saved = new Map(result.assignments.map(({ id, orderKey }) => [id, orderKey]));
    expect(
      sortThreadsForSidebar(
        ["work1", "work2"].map((id) => ({
          id,
          createdAt: "2026-03-09T08:00:00.000Z",
          activeOrderKey: saved.get(id),
        })),
      ).map(({ id }) => id),
    ).toEqual(["work2", "work1"]);
  });

  it.each([
    ["work2", "input"],
    ["work1", "failed"],
    ["done2", "done1"],
  ])(
    "rejects an arbitrary active position from %s to %s in drop resolution and preview",
    (source, over) => {
      expect(resolve(source!, over!)).toBeNull();
      const result = preview(
        { items, resolveTarget: resolve, settledOrder: [], settledExpanded: false },
        source!,
        over!,
      );
      expect([...result.values()].every((transform) => transform?.y === 0)).toBe(true);
    },
  );

  it("opens boundary label space on ended pickup without allowing reorder", () => {
    const target = resolve("done1", "done1")!;
    expect(plan("done1", target).kind).toBe("none");
    const result = preview(
      {
        items,
        resolveTarget: resolve,
        settledOrder: [],
        settledExpanded: false,
        boundaryLabelHeight: 16,
      },
      "done1",
      "done1",
    );
    expect(result.get("input")?.y).toBe(32);
  });

  it.each(["done1", "failed"])("lets %s leave active for pinned or settled", (source) => {
    expect(plan(source, resolve(source, sidebarMarkerId("pinned-header"))!).kind).toBe("pin");
    expect(plan(source, resolve(source, sidebarMarkerId("settled-header"))!).kind).toBe("settle");
  });

  it("refreshes the active gap after another thread completes between pickup and release", () => {
    const base = {
      createdAt: "2026-03-09T08:00:00.000Z",
      updatedAt: "2026-03-09T08:00:00.000Z",
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      runtime: null,
      latestRun: null,
      pinnedAt: null as string | null,

      pinOrderKey: null,
      activeOrderKey: null,
      settledAt: null,
      settledOverride: null,
      unsettledAt: null,
      snoozedAt: null,
      snoozedUntil: null,
    };
    const pickupAt = "2026-03-09T12:00:00.000Z";
    const completionAt = "2026-03-09T12:00:05.000Z";
    const releaseAt = "2026-03-09T12:00:10.000Z";
    const source: typeof base & { id: string } = {
      ...base,
      id: "source",
      pinnedAt: base.createdAt,
    };
    const working = {
      ...base,
      id: "other",
      runtime: {
        status: "running" as const,
        activeRunId: null,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerName: "Codex",
        lastError: null,
        updatedAt: pickupAt,
      },
    };
    const completed: typeof source = { ...base, id: "other", updatedAt: completionAt };
    const options = (now: string) => ({
      now,
      lastVisitedAt: () => undefined,
      hasUnsentText: () => false,
    });
    const key = (row: { id: string }) => row.id;
    expect(
      projectSidebarActiveDropOrder(
        source,
        [working, source].filter((row) => row.id !== source.id),
        key,
        options(pickupAt),
      ),
    ).toEqual(["other", "source"]);
    // Keeping pickup time after the completion would advertise the wrong gap.
    expect(projectSidebarActiveDropOrder(source, [completed], key, options(pickupAt))).toEqual([
      "other",
      "source",
    ]);
    const rows = [
      pinnedHeader,
      thread("source", "pinned"),
      divider,
      thread("other", "active"),
      settledHeader,
    ];
    const targetAt = (now: string) =>
      constrainSidebarDropTarget({
        target: resolveSidebarDropTarget(rows, "source", "other"),
        activeKey: "source",
        activeSection: "pinned",
        activeOrder: ["other"],
        groups: new Map([["other", "ended"]]),
        enteringActiveOrder: projectSidebarActiveDropOrder(source, [completed], key, options(now)),
      })!;
    const refreshedTarget = targetAt("2026-03-09T12:00:06.000Z");
    const releaseTarget = targetAt(releaseAt);
    expect(refreshedTarget.activeOrder).toEqual(["source", "other"]);
    expect(releaseTarget.activeOrder).toEqual(refreshedTarget.activeOrder);
    const transforms = (target: typeof releaseTarget) =>
      preview(
        {
          items: rows,
          resolveTarget: () => target,
          settledOrder: [],
          settledExpanded: false,
        },
        "source",
        "other",
      );
    expect(transforms(refreshedTarget)).toEqual(transforms(releaseTarget));
    expect(transforms(releaseTarget).get("other")?.y).toBeGreaterThan(
      transforms(targetAt(pickupAt)).get("other")!.y,
    );
    expect(plan("source", releaseTarget, "pinned")).toMatchObject({
      kind: "move-active",
      order: ["source", "other"],
      assignments: [],
      unpin: true,
    });
    const optimistic = applySidebarThreadDrop(source, "active", releaseAt);
    const server = { ...source, pinnedAt: null, updatedAt: "2026-03-09T12:00:11.000Z" };
    for (const result of [optimistic, server]) {
      expect(
        orderSidebarThreadsByStatus(
          sortThreadsForSidebar([completed, result]),
          options(releaseAt),
        ).map(key),
      ).toEqual(releaseTarget.activeOrder);
    }
  });

  it("withdraws the settle target when another client settles the dragged source", () => {
    const source = { activeKey: "work1", activeSection: "active" as const };
    const targetId = sidebarMarkerId("settled-header");
    expect(isSidebarDragSourceValid(items, source)).toBe(true);
    expect(resolveSidebarDropVerb(source.activeSection, resolve("work1", targetId)!.section)).toBe(
      "settle",
    );
    const updatedRows = [
      ...items.filter((item) => sidebarListItemId(item) !== source.activeKey),
      thread(source.activeKey, "settled"),
    ];
    expect(isSidebarDragSourceValid(updatedRows, source)).toBe(false);
    const resolveAfterUpdate = (activeKey: string, overId: string) =>
      isSidebarDragSourceValid(updatedRows, source)
        ? resolveSidebarDropTarget(updatedRows, activeKey, overId)
        : null;
    const target = resolveAfterUpdate(source.activeKey, targetId);
    expect(target).toBeNull();
    expect(resolveSidebarDropVerb(source.activeSection, target?.section ?? null)).toBeNull();
    const transforms = preview(
      {
        items: updatedRows,
        resolveTarget: resolveAfterUpdate,
        settledOrder: [source.activeKey],
        settledExpanded: true,
      },
      source.activeKey,
      targetId,
    );
    expect([...transforms.values()].every((transform) => transform?.y === 0)).toBe(true);
    const { rects, activeIndex, overIndex } = layout(updatedRows, source.activeKey, targetId);
    const collisionRect = rects[overIndex]!;
    const detector = createSidebarCollisionDetection(
      (id) => resolveAfterUpdate(source.activeKey, id) !== null,
    );
    const collisions = detector({
      active: {
        id: source.activeKey,
        data: { current: {} },
        rect: { current: { initial: rects[activeIndex]!, translated: collisionRect } },
      },
      collisionRect,
      droppableRects: new Map(
        updatedRows.map((item, index) => [sidebarListItemId(item), rects[index]!]),
      ),
      droppableContainers: updatedRows.map((item, index) => ({
        id: sidebarListItemId(item),
        key: sidebarListItemId(item),
        disabled: false,
        data: { current: {} },
        node: { current: null },
        rect: { current: rects[index]! },
      })),
      pointerCoordinates: null,
    });
    expect(collisions.map(({ id }) => id)).toEqual([source.activeKey]);
  });

  it.each(
    (["pinned", "settled", "snoozed"] as const).flatMap((section) =>
      (["ended", "failed"] as const).map((status) => ({ section, status })),
    ),
  )(
    "uses projected lifecycle state for a $status $section thread's active gap, drop and final order",
    ({ section, status }) => {
      const now = "2026-03-09T12:00:00.000Z";
      const earlier = "2026-03-09T08:00:00.000Z";
      const base = {
        createdAt: earlier,
        updatedAt: earlier,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        runtime: null,
        latestRun: null,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
        settledAt: null,
        settledOverride: null,
        unsettledAt: null,
        snoozedAt: null,
        snoozedUntil: null,
      };
      const source = {
        ...base,
        id: "source",
        runtime:
          status === "failed"
            ? {
                threadId: ThreadId.make("source"),
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerName: "Codex",
                runtimeMode: DEFAULT_RUNTIME_MODE,
                status: "failed" as const,
                activeRunId: null,
                lastError: "Failed",
                updatedAt: earlier,
              }
            : null,
        pinnedAt: section === "pinned" ? earlier : null,
        settledOverride: section === "settled" ? ("settled" as const) : null,
        snoozedUntil: section === "snoozed" ? "2026-03-09T11:00:00.000Z" : null,
      };
      const live = [
        {
          ...base,
          id: "working",
          runtime: {
            status: "running" as const,
            activeRunId: null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: "Codex",
            lastError: null,
            updatedAt: now,
          },
        },
        { ...base, id: "newer", updatedAt: "2026-03-09T10:00:00.000Z" },
      ];
      const options = { now, lastVisitedAt: () => undefined, hasUnsentText: () => false };
      const projected = applySidebarThreadDrop(source, "active", now);
      expect(projected.snoozedUntil).toBeNull();
      expect(projected.unsettledAt).toBe(section === "settled" ? now : null);
      const canonical = orderSidebarThreadsByStatus(
        sortThreadsForSidebar([...live, projected]),
        options,
      ).map(({ id }) => id);
      expect(canonical).toEqual(["working", "source", "newer"]);
      const rows = [
        pinnedHeader,
        ...(section === "pinned" ? [thread("source", section)] : []),
        divider,
        ...live.map(({ id }) => thread(id, "active")),
        ...(section === "snoozed" ? [marker("snoozed-header"), thread("source", section)] : []),
        settledHeader,
        ...(section === "settled" ? [thread("source", section)] : []),
      ];
      const targetFor = (activeKey: string, overId: string) =>
        constrainSidebarDropTarget({
          target: resolveSidebarDropTarget(rows, activeKey, overId),
          activeKey,
          activeSection: section,
          activeOrder: live.map(({ id }) => id),
          groups: new Map(live.map((row) => [row.id, sidebarActiveGroup(row, options)])),
          enteringActiveOrder: canonical,
        });
      const target = targetFor("source", "working")!;
      const result = plan("source", target, section);
      expect(result).toMatchObject({
        kind: "move-active",
        order: canonical,
        assignments: [],
        unpin: section === "pinned",
        unsettle: section === "settled",
        unsnooze: section === "snoozed",
      });
      // Hovering over either active row must open the same canonical gap.
      const input = {
        items: rows,
        resolveTarget: targetFor,
        settledOrder: [],
        settledExpanded: true,
      };
      expect(preview(input, "source", "working")).toEqual(preview(input, "source", "newer"));
      const geometry = layout(rows, "source", "working");
      const transforms = preview(input, "source", "working");
      const workingIndex = rows.findIndex((row) => sidebarListItemId(row) === "working");
      const newerIndex = rows.findIndex((row) => sidebarListItemId(row) === "newer");
      const workingBottom = geometry.rects[workingIndex]!.bottom + transforms.get("working")!.y;
      const newerTop = geometry.rects[newerIndex]!.top + transforms.get("newer")!.y;
      expect(newerTop - workingBottom).toBe(84); // One full active card plus row gaps.
      // These are the fields written by the unpin/unsettle/unsnooze reducers.
      const serverNow = "2026-03-09T12:00:01.000Z";
      const final = {
        ...source,
        pinnedAt: null,
        pinOrderKey: null,
        snoozedAt: null,
        snoozedUntil: null,
        settledOverride: section === "settled" ? ("active" as const) : null,
        settledAt: null,
        unsettledAt: section === "settled" ? serverNow : null,
        updatedAt: serverNow,
      };
      expect(
        orderSidebarThreadsByStatus(sortThreadsForSidebar([...live, final]), options).map(
          ({ id }) => id,
        ),
      ).toEqual(canonical);
    },
  );
});
