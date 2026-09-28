import { beforeAll, describe, expect, it } from "bun:test";
import { StatusLineComponent } from "../src/status-line/component";
import type { StatusLineHost, StatusLineSession } from "../src/status-line/host";
import type { SegmentContext } from "../src/status-line/segments";
import type { StatusLineRenderer } from "../src/status-line/types";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

function createSession(modelName: string): StatusLineSession {
	return {
		state: { model: { id: modelName, name: modelName }, messages: [] },
		isStreaming: false,
		isAutoThinking: false,
		sessionManager: {
			getSessionName: () => undefined,
			getSessionId: () => "session-1",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		modelRegistry: { isUsingOAuth: () => false },
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
	} as unknown as StatusLineSession;
}

function createHost(): StatusLineHost {
	return {
		// A real segment list, so "the built-in bar has the surface" is
		// observable. With no segments configured the bar renders empty and every
		// assertion about it would pass for the wrong reason.
		getSettings: () => ({ preset: "custom", leftSegments: ["model"], rightSegments: [] }),
		gitEnabled: () => false,
		codexResetFireworksEnabled: () => false,
		getSettingsRevision: () => 0,
		getSessionSettingsIdentity: () => "session-1",
		getSessionSettingsRevision: () => 0,
		goalStatusInFooter: () => false,
		activeAccount: () => undefined,
		canFetchUsageReports: () => false,
		fetchUsageReports: () => Promise.resolve(undefined),
		resolveActiveRepo: () => null,
		lookupPullRequest: () => Promise.resolve({ stdout: "", exitCode: 0 }),
		calculateTokensPerSecond: () => null,
		limitMatchesActiveAccount: () => false,
		computeCompactionBoundaries: () => null,
	} as unknown as StatusLineHost;
}

/**
 * Every built-in placement that could paint the surface a second time.
 *
 * The prepaint frame is not among them: `createStartupStatusLine` builds a
 * separate component that is disposed when the session-bound bar mounts, so it
 * never shares this component's override and cannot duplicate the rows.
 */
function builtInSurfaces(component: StatusLineComponent, width: number): Record<string, string> {
	return {
		topBorder: component.getTopBorder(width).content,
		bandTopBorder: component.getBandTopBorder(width).content,
		standaloneTopBorder: component.getStandaloneTopBorder(width).content,
	};
}

/**
 * A component with the standalone bottom bar actually enabled, so "the built-in
 * bar owns the surface" is observable. A bare component leaves `#standalone`
 * false and paints nothing, which would make every claim about who holds the
 * surface pass for the wrong reason.
 */
function createComponent(modelName: string): StatusLineComponent {
	const component = new StatusLineComponent(createSession(modelName), createHost());
	component.setComposerStyle({ statusAttachment: "none", bottomBar: "full", bottomBarGap: false });
	return component;
}

describe("status line renderer override", () => {
	it("paints the renderer's rows through the one status surface", () => {
		const component = createComponent("main-model");
		expect(component.render(80).join("\n")).toContain("main-model");

		component.setRendererOverride({ id: "rows", label: "Rows", render: () => ["ROW-A", "ROW-B"] });

		// The composer's StatusHost is the only thing that may show the rows...
		expect(component.render(80)).toEqual(["ROW-A", "ROW-B"]);
		// ...so every built-in placement must be empty, or the rows are painted
		// twice and each frame builds a second SegmentContext.
		expect(builtInSurfaces(component, 80)).toEqual({
			topBorder: "",
			bandTopBorder: "",
			standaloneTopBorder: "",
		});
	});

	it("yields the renderer's rows, truncated to the available width", () => {
		const component = new StatusLineComponent(createSession("main-model"), createHost());
		const renderer: StatusLineRenderer = {
			id: "rows",
			label: "Rows",
			render: () => ["first row", "second row", "a".repeat(120)],
		};
		component.setRendererOverride(renderer);
		const rows = component.render(40);
		expect(rows).toHaveLength(3);
		expect(rows[0]).toBe("first row");
		expect(rows[1]).toBe("second row");
		expect(rows[2]?.length).toBe(40);
	});

	it("expands tabs in renderer rows and keeps one row from injecting another", () => {
		const component = new StatusLineComponent(createSession("main-model"), createHost());
		component.setRendererOverride({
			id: "rows",
			label: "Rows",
			render: () => ["a\tb", "first\nsecond", "trailing\r\n"],
		});
		// A raw tab punches a hole in the terminal, and an embedded newline would
		// smuggle in an extra TUI row the renderer never declared.
		expect(component.render(80)).toEqual(["a   b", "first second", "trailing "]);
	});

	it("hands the renderer the focused subagent session and id", () => {
		const main = createSession("main-model");
		const sub = createSession("subagent-model");
		const component = new StatusLineComponent(main, createHost());
		const seen: SegmentContext[] = [];
		component.setRendererOverride({
			id: "rows",
			label: "Rows",
			render: ctx => {
				seen.push(ctx);
				return [ctx.session.state.model?.name ?? ""];
			},
		});

		expect(component.render(80)).toEqual(["main-model"]);

		component.setSession(sub, "agent-7");
		expect(component.render(80)).toEqual(["subagent-model"]);
		expect(seen.at(-1)?.focusedAgentId).toBe("agent-7");
		expect(seen.at(-1)?.session).toBe(sub);

		component.setSession(main, undefined);
		expect(component.render(80)).toEqual(["main-model"]);
		expect(seen.at(-1)?.focusedAgentId).toBeUndefined();
	});

	it("hands the built-in bar back when the renderer is removed", () => {
		const component = createComponent("main-model");
		component.setRendererOverride({ id: "rows", label: "Rows", render: () => ["row"] });
		expect(component.render(80)).toEqual(["row"]);

		component.setRendererOverride(undefined);
		expect(component.render(80).join("\n")).toContain("main-model");
	});

	it("reports a broken renderer and does not reinstall it on the next sync", () => {
		const component = createComponent("main-model");
		const reported: { error: unknown; id: string }[] = [];
		component.setRendererErrorSink((error, renderer) => reported.push({ error, id: renderer.id }));

		let calls = 0;
		const broken: StatusLineRenderer = {
			id: "rows",
			label: "Rows",
			render: () => {
				calls++;
				throw new Error("boom");
			},
		};
		component.setRendererOverride(broken);

		// The throw must not blank the surface: the built-in bar takes it back.
		expect(component.render(80).join("\n")).toContain("main-model");
		expect(reported).toHaveLength(1);
		expect(reported[0]?.id).toBe("rows");
		expect(String(reported[0]?.error)).toContain("boom");

		// The runner still holds the broken renderer, so a shape re-sync would
		// otherwise reinstall it on the very next frame.
		component.setRendererOverride(broken);
		expect(component.render(80).join("\n")).toContain("main-model");
		expect(calls).toBe(1);

		// A genuine re-registration is the escape hatch for a renderer that has
		// been fixed, so it gets one more attempt.
		component.setRendererOverride(broken, { retry: true });
		component.render(80);
		expect(calls).toBe(2);
	});

	it("previews the renderer's rows instead of the bar it replaced", () => {
		const component = new StatusLineComponent(createSession("main-model"), createHost());
		component.setRendererOverride({ id: "rows", label: "Rows", render: () => ["preview row", "second"] });
		expect(component.getPreviewLines(80)).toEqual(["preview row", "second"]);
	});
});

/**
 * The Tern Surface Protocol path builds its bar from `describeComposerFacts()`
 * and never reads `render()`, so a renderer cannot reach it. The component
 * therefore cannot know whether an installed override is actually being
 * painted; the decision belongs to the host, which declines the override while
 * a surface is live. These tests pin the fact the host's decision rests on, so
 * a future `describeComposerFacts` that starts honouring the override is caught
 * here rather than by a Tern user.
 */
describe("the TSP native surface", () => {
	it("ignores the renderer override, so the host must decline it there", () => {
		const component = createComponent("main-model");
		const before = component.describeComposerFacts();
		component.setRendererOverride({ id: "rows", label: "Rows", render: () => ["ROW-A"] });

		// The box surface took the rows...
		expect(component.render(80)).toEqual(["ROW-A"]);
		// ...while the native facts came back identical, i.e. unaffected. If this
		// ever changes, the host gate can be narrowed and a renderer can serve
		// both surfaces.
		expect(component.describeComposerFacts()).toEqual(before);
	});
});
