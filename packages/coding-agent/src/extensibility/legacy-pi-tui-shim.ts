/**
 * Compatibility shim for legacy extensions importing the package root of
 * `@earendil-works/pi-tui` or `@mariozechner/pi-tui`.
 *
 * The host serves that root from this module — both resolver modes route here,
 * see `scripts/legacy-pi-virtual-module.ts` — so every *runtime* name a Pi
 * extension imports has to be reachable from this file: ESM validates each
 * named import while linking the module graph, and one missing name fails the
 * whole extension to load.
 *
 * That is also why these names live here and not on `@oh-my-pi/pi-tui`. Two
 * rules:
 * - The historical root exported `decodeKittyPrintable`; the canonical TUI now
 *   exposes the equivalent, broader `decodePrintableKey`. Keep the legacy name
 *   without reintroducing it into the canonical surface.
 * - Everything below is Pi's layout, compositing, and image vocabulary. It is
 *   served, not adopted: this package keeps its own components, and no Pi-only
 *   name has to exist on `@oh-my-pi/pi-tui` for a Pi extension to load.
 *
 * Known divergences from Pi, all bounded by the same input and output width:
 * - `HStack`'s `shrink` is accepted and ignored. When slots overflow the
 *   granted width this package's allocator collapses the last ones down to
 *   their minimum, where Pi shrinks every slot in proportion to its `shrink`
 *   weight and size.
 * - Rows are padded to the full render width; Pi leaves the trailing gap blank.
 * - `ImageProtocol` and Pi's `StackChild`/`StackEntry`/`StackOptions` type names
 *   are already taken by `@oh-my-pi/pi-tui`, so they are mirrored under the
 *   `HStack*` names below.
 */
import {
	type Component,
	type DescribeContext,
	extractSegments,
	ImageProtocol,
	isHeightConstrainedComponent,
	isLayoutMouseRoutable,
	type LayoutAlignment,
	layoutSize,
	type NativeNode,
	Row,
	type RowChild,
	SEGMENT_RESET,
	type SgrMouseEvent,
	sliceByColumn,
	sliceWithWidth,
	TERMINAL,
	visibleWidth,
} from "@oh-my-pi/pi-tui";

export * from "@oh-my-pi/pi-tui";
export { decodePrintableKey as decodeKittyPrintable } from "@oh-my-pi/pi-tui";

/** What the terminal can be asked to draw, in Pi's shape. */
export interface TerminalCapabilities {
	/** Inline-image protocol, or null when the terminal draws no inline images. */
	images: "kitty" | "iterm2" | null;
	/** 24-bit colour support. */
	trueColor: boolean;
	/** OSC 8 hyperlink support. */
	hyperlinks: boolean;
}

/** Report canonical terminal capabilities through the legacy Pi TUI shape. */
export function getCapabilities(): TerminalCapabilities {
	const images =
		TERMINAL.imageProtocol === ImageProtocol.Kitty
			? "kitty"
			: TERMINAL.imageProtocol === ImageProtocol.Iterm2
				? "iterm2"
				: null;
	return { images, trueColor: TERMINAL.trueColor, hyperlinks: TERMINAL.hyperlinks };
}

/**
 * Delete one Kitty graphics image by id, matching the legacy Pi TUI helper.
 *
 * Returns the bare control sequence exactly like upstream Pi: legacy callers
 * (e.g. pi-sprite) apply their own tmux passthrough wrapping, so wrapping here
 * would double-wrap under tmux and the outer terminal would drop the command.
 */
export function deleteKittyImage(imageId: number): string {
	return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}

/** Delete every Kitty graphics image using the legacy Pi TUI bare sequence. */
export function deleteAllKittyImages(): string {
	return "\x1b_Ga=d,d=A,q=2\x1b\\";
}

/**
 * A Kitty graphics id in `[1, 0xfffffffe]`.
 *
 * Random rather than sequential: two copies of a plugin in one process would
 * otherwise hand the terminal the same id for two different images and the
 * second placement would replace the first.
 */
export function allocateImageId(): number {
	return Math.floor(Math.random() * 0xfffffffe) + 1;
}

/**
 * Composite `overlayLine` into `baseLine` at `startCol`, keeping the result
 * exactly `totalWidth` visible cells wide — Pi's own algorithm, so an extension
 * composites the way it would under Pi.
 *
 * ANSI/OSC sequences travel with the cells they style instead of being copied
 * verbatim, so a splice never leaks styling across the seam. The final
 * `sliceByColumn` is the hard guarantee: width tracking can drift from the
 * rendered width on exotic sequences and wide characters at a boundary, and an
 * over-wide row crashes the terminal.
 */
export function compositeTuiLine(
	baseLine: string,
	overlayLine: string,
	startCol: number,
	overlayWidth: number,
	totalWidth: number,
): string {
	// An image row carries Kitty/Sixel/iTerm2 placement sequences that cannot be
	// split at an arbitrary column, so the base survives untouched.
	if (TERMINAL.isImageLine(baseLine)) return baseLine;

	// An overlay reaching past the right edge leaves nothing to keep after it.
	// Pi's own extractSegments branches on `afterLen <= 0`; the native one takes
	// it as a u32, so a negative length would ask for a multi-exabyte slice and
	// abort the process instead of returning a short row.
	const afterStart = startCol + Math.max(0, overlayWidth);
	const afterLen = Math.max(0, totalWidth - afterStart);
	const base = extractSegments(baseLine, startCol, afterStart, afterLen, true);
	const overlay = sliceWithWidth(overlayLine, 0, Math.max(0, overlayWidth), true);

	const beforePad = Math.max(0, startCol - base.beforeWidth);
	const overlayPad = Math.max(0, overlayWidth - overlay.width);
	const actualBeforeWidth = Math.max(startCol, base.beforeWidth);
	const actualOverlayWidth = Math.max(overlayWidth, overlay.width);
	const afterTarget = Math.max(0, totalWidth - actualBeforeWidth - actualOverlayWidth);
	const afterPad = Math.max(0, afterTarget - base.afterWidth);

	const result =
		base.before +
		" ".repeat(beforePad) +
		SEGMENT_RESET +
		overlay.text +
		" ".repeat(overlayPad) +
		SEGMENT_RESET +
		base.after +
		" ".repeat(afterPad);

	return visibleWidth(result) <= totalWidth ? result : sliceByColumn(result, 0, totalWidth, true);
}

/**
 * The Pi brand marking a TUI that renders a replaceable layout root into the
 * terminal viewport. Module-local: Pi's own package root exports `isViewportTUI`
 * and the `ViewportTUI` type but not this symbol, and `@oh-my-pi/pi-tui` must
 * not grow a Pi-only name for the sake of one.
 */
const VIEWPORT_TUI = Symbol.for("@earendil-works/pi-tui/viewport");

/** A Pi TUI whose child list can be replaced by a single layout root. */
export interface ViewportTUI {
	/** The override root, or undefined while the child list is rendering. */
	readonly layoutRoot: Component | undefined;
	/** Replace the single root rendered into the viewport; `undefined` restores the child list. */
	setLayoutRoot(component: Component | undefined): void;
}

/**
 * Whether `tui` owns the viewport the way Pi's `TuiAltScreen` does.
 *
 * omp's `TUI` deliberately does not carry the brand: it paints its child list
 * through the composer's frame provider rather than through `TUI.render()`, so a
 * `setLayoutRoot` installed on it would be silently ignored. Reporting false
 * keeps an extension on its own fallback instead of letting it believe the
 * whole viewport was handed over.
 */
export function isViewportTUI(tui: unknown): tui is ViewportTUI {
	return typeof tui === "object" && tui !== null && (tui as Record<symbol, unknown>)[VIEWPORT_TUI] === true;
}

/** The rectangle a stack child is measured against, in Pi's shape. */
export interface LayoutViewport {
	/** Columns the whole stack is being rendered at. */
	width: number;
	/** Rows available; a horizontal stack is never height-constrained. */
	height: number;
}

/** Sizing for one {@link HStack} child, in Pi's flexbox-like descriptor shape. */
export interface HStackChildOptions {
	/** Width this slot starts from, or `"auto"` to measure the child. */
	basis?: number | "auto";
	/** Share of the leftover width this slot takes. */
	grow?: number;
	/** Accepted for compatibility; this package's allocator does not shrink. */
	shrink?: number;
	/** Lower bound in columns. */
	minSize?: number;
	/** Upper bound in columns. */
	maxSize?: number;
	/** Render this slot only while the predicate holds. */
	visible?: (viewport: LayoutViewport) => boolean;
}

/** One measured child of an {@link HStack}. */
export interface HStackEntry extends HStackChildOptions {
	/** The component rendered in this slot. */
	component: Component;
}

/** A child of an {@link HStack}: a bare component, or one carrying sizing. */
export type HStackChild = Component | HStackEntry;

/** Construction options for {@link HStack}. */
export interface HStackOptions {
	/** Columns inserted between adjacent children. Defaults to 0. */
	gap?: number;
	/** Vertical alignment of shorter children against the tallest. */
	align?: "stretch" | "start" | "center" | "end";
}

const isEntry = (child: HStackChild): child is HStackEntry => !("render" in child);

/** Normalize an optional size the way Pi's stack constructor does. */
const normalizeSize = (value: number | undefined): number =>
	value === undefined || !Number.isFinite(value) ? 0 : Math.max(0, Math.floor(value));

/** Pi's `"stretch"` and this package's `"start"` both bottom-pad to the row. */
const toAlignment = (align: HStackOptions["align"]): LayoutAlignment =>
	align === "center" || align === "end" ? align : "start";

/** Bounds an entry may be laid out within, with Pi's max-wins-over-min rule. */
const entryBounds = (entry: HStackEntry): { minWidth?: number; maxWidth?: number } => {
	const minWidth = normalizeSize(entry.minSize);
	if (entry.maxSize === undefined) return entry.minSize === undefined ? {} : { minWidth };
	return { minWidth, maxWidth: Math.max(minWidth, Math.floor(entry.maxSize)) };
};

/**
 * One entry's component, pre-fitted to whatever width its slot is granted.
 *
 * Pi composites each child with `sliceWithWidth(..., strict)`, so a child wider
 * than its slot is cut at the column. This package's row fits a slot's content
 * with the Unicode ellipsis instead — right for a truncated *line*, wrong for a
 * Pi slot. Slicing here leaves the row's own behaviour (padding, alignment, the
 * exact row budget, mouse routing) untouched while the child is clipped the way
 * Pi clips it.
 *
 * The fitted rows are memoized on the inner component's own output identity,
 * because the row recognizes an unchanged slot by reference and would otherwise
 * rebuild the whole row every frame.
 */
class SlotFitter implements Component {
	readonly #inner: Component;
	#width = -1;
	#source: readonly string[] | undefined;
	#fitted: readonly string[] = [];

	constructor(inner: Component) {
		this.#inner = inner;
	}

	render(width: number): readonly string[] {
		const target = layoutSize(width);
		const source = this.#inner.render(target);
		if (source === this.#source && target === this.#width) return this.#fitted;
		const fitted = source.map(line => (visibleWidth(line) > target ? sliceByColumn(line, 0, target, true) : line));
		this.#source = source;
		this.#width = target;
		this.#fitted = fitted;
		return fitted;
	}

	describe(cx: DescribeContext): NativeNode | null {
		return this.#inner.describe?.(cx) ?? null;
	}

	setHeight(height: number | undefined): void {
		if (isHeightConstrainedComponent(this.#inner)) this.#inner.setHeight(height);
	}

	setIgnoreTight(ignore: boolean): this {
		this.#inner.setIgnoreTight?.(ignore);
		return this;
	}

	invalidate(): void {
		this.#source = undefined;
		this.#inner.invalidate?.();
	}

	dispose(): void {
		this.#inner.dispose?.();
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (isLayoutMouseRoutable(this.#inner)) this.#inner.routeMouse(event, line, col);
	}
}

/** One slot: Pi's descriptor plus the fitted view the row is handed. */
interface HStackSlot {
	entry: HStackEntry;
	view: SlotFitter;
}

/**
 * One entry as a row child, starting `basis` columns wide.
 *
 * A growing slot cannot be pinned to a width or it would never grow, so its
 * clamped start becomes the floor the row allocator hands out — which is exactly
 * the width Pi's own allocator gives it before distributing the leftover.
 */
const toRowChild = (slot: HStackSlot, basis: number): RowChild => {
	const bounds = entryBounds(slot.entry);
	const minimum = bounds.minWidth ?? 0;
	const maximum = bounds.maxWidth ?? Number.MAX_SAFE_INTEGER;
	const initial = Math.min(maximum, Math.max(minimum, normalizeSize(basis)));
	const grow = normalizeSize(slot.entry.grow);
	if (grow > 0) return { content: slot.view, grow, ...bounds, minWidth: initial };
	return { content: slot.view, ...bounds, width: initial };
};

/** One entry as a row child sized by content, for the native description. */
const toContentRowChild = (slot: HStackSlot): RowChild => ({
	content: slot.view,
	...(slot.entry.grow === undefined ? {} : { grow: normalizeSize(slot.entry.grow) }),
	...entryBounds(slot.entry),
});

/** Natural width of a child rendered at `available`, in columns. */
const intrinsicWidth = (component: Component, available: number): number => {
	let width = 0;
	for (const line of component.render(available)) width = Math.max(width, visibleWidth(line));
	return width;
};

/**
 * Horizontal layout: children side by side, sized by Pi's stack descriptors.
 *
 * Each frame re-evaluates {@link HStackChildOptions.visible} against the width
 * actually granted, so a child can appear and disappear as the terminal resizes
 * without the parent rebuilding the stack. A child with no `basis` is measured at
 * the granted width and laid out at its natural size, as in Pi.
 */
export class HStack implements Component {
	readonly #gap: string;
	readonly #row: Row;
	#slots: HStackSlot[] = [];

	constructor(children: readonly HStackChild[] = [], options: HStackOptions = {}) {
		const gap = normalizeSize(options.gap);
		this.#gap = gap > 0 ? " ".repeat(gap) : "";
		this.#row = new Row({ children: [], gap: this.#gap, align: toAlignment(options.align) });
		for (const child of children) {
			if (isEntry(child)) this.addChild(child.component, child);
			else this.addChild(child);
		}
	}

	/** The components currently held by the stack, in layout order. */
	get children(): readonly Component[] {
		return this.#slots.map(slot => slot.entry.component);
	}

	/** Append a child, optionally with Pi's sizing descriptor. */
	addChild(component: Component, options: HStackChildOptions = {}): void {
		this.#append({ component, ...options });
	}

	/** Detach a child, matching by component identity. */
	removeChild(component: Component): void {
		const index = this.#slots.findIndex(slot => slot.entry.component === component);
		if (index === -1) return;
		this.#slots.splice(index, 1);
		this.#syncRow();
	}

	/** Detach every child. */
	clear(): void {
		this.#slots = [];
		this.#syncRow();
	}

	setIgnoreTight(ignore: boolean): this {
		this.#row.setIgnoreTight(ignore);
		return this;
	}

	invalidate(): void {
		this.#row.invalidate();
	}

	dispose(): void {
		this.#row.dispose();
	}

	/**
	 * The row's own native description. A width-dependent `visible` predicate
	 * cannot be expressed in a native node, so a stack carrying one falls back to
	 * rendering its rows; so does a stack with nothing in it.
	 */
	describe(cx: DescribeContext): NativeNode | null {
		if (this.#slots.length === 0 || this.#slots.some(slot => slot.entry.visible !== undefined)) return null;
		this.#syncRow();
		return this.#row.describe(cx);
	}

	render(width: number): readonly string[] {
		const safeWidth = Math.max(1, layoutSize(width));
		const viewport: LayoutViewport = { width: safeWidth, height: Number.MAX_SAFE_INTEGER };
		const visible = this.#slots.filter(slot => slot.entry.visible?.(viewport) ?? true);
		if (visible.length === 0) return [];
		this.#row.setChildren(
			visible.map(slot =>
				slot.entry.basis === undefined || slot.entry.basis === "auto"
					? toRowChild(slot, intrinsicWidth(slot.entry.component, safeWidth))
					: toRowChild(slot, slot.entry.basis),
			),
		);
		return this.#row.render(safeWidth);
	}

	#append(entry: HStackEntry): void {
		this.#slots.push({ entry, view: new SlotFitter(entry.component) });
		this.#syncRow();
	}

	/**
	 * Push the current slots into the row without measuring, leaving `basis`
	 * unset so the native description sizes those slots by content.
	 */
	#syncRow(): void {
		this.#row.setChildren(this.#slots.map(slot => toContentRowChild(slot)));
	}
}
