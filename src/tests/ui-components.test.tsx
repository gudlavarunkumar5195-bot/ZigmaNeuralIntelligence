// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { ConfirmDialog, Dialog } from "../components/ui/Dialog";
import { ToastProvider, useToast } from "../components/ui/Toast";
import { Tooltip } from "../components/ui/Tooltip";
import { Delta, KpiCard, Sparkline } from "../components/ui/Kpi";
import { ChartFrame, Field, RouteTabs } from "../components/ui/Primitives";
import { PageHeader } from "../components/ui/Card";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("Dialog and ConfirmDialog", () => {
  it("renders nothing until opened, then a labelled dialog with a close button", async () => {
    const onClose = vi.fn();
    const { rerender } = render(<Dialog open={false} onClose={onClose} title="Edit brand" description="Change the name">Body</Dialog>);
    expect(screen.queryByText("Body")).toBeNull();
    rerender(<Dialog open onClose={onClose} title="Edit brand" description="Change the name">Body</Dialog>);
    const dialog = screen.getByRole("dialog", { name: "Edit brand" });
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("Change the name").id).toBe(dialog.getAttribute("aria-describedby"));
    await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("confirms or cancels with explicit labels", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="Delete project?" description="Its history is removed." confirmLabel="Delete project" onConfirm={onConfirm} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete project" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("disables both actions while busy", () => {
    render(<ConfirmDialog open busy title="Delete?" description="x" confirmLabel="Delete" onConfirm={() => undefined} onCancel={() => undefined} />);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: /Delete/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Toast", () => {
  function Trigger({ tone }: { tone: "success" | "error" }) {
    const { notify } = useToast();
    return <button onClick={() => notify(tone === "error" ? "Save failed" : "Saved", tone)}>notify</button>;
  }

  it("announces success politely and removes it after a few seconds", async () => {
    vi.useFakeTimers();
    render(<ToastProvider><Trigger tone="success" /></ToastProvider>);
    act(() => screen.getByRole("button", { name: "notify" }).click());
    expect(screen.getByRole("status").textContent).toContain("Saved");
    act(() => { vi.advanceTimersByTime(5_100); });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps errors until dismissed", async () => {
    vi.useFakeTimers();
    render(<ToastProvider><Trigger tone="error" /></ToastProvider>);
    act(() => screen.getByRole("button", { name: "notify" }).click());
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByRole("alert").textContent).toContain("Save failed");
    act(() => screen.getByRole("button", { name: "Dismiss notification" }).click());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is a no-op without a provider", () => {
    render(<Trigger tone="success" />);
    expect(() => act(() => screen.getByRole("button", { name: "notify" }).click())).not.toThrow();
  });
});

describe("Tooltip", () => {
  it("shows on keyboard focus, links with aria-describedby and hides on Escape", async () => {
    render(<Tooltip content="Share of answers mentioning the brand"><button>Visibility</button></Tooltip>);
    const trigger = screen.getByRole("button", { name: "Visibility" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    await userEvent.tab();
    const tip = screen.getByRole("tooltip");
    expect(trigger.getAttribute("aria-describedby")).toBe(tip.id);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("Delta, Sparkline and KpiCard", () => {
  it("states direction and judgement in words, not only colour", () => {
    render(<><Delta value={0.125} /><Delta value={-3} format="abs" better="down" /><Delta value={0} /><Delta value={null} /></>);
    expect(screen.getByText("up 12.5%, better")).toBeTruthy();
    expect(screen.getByText("down 3, better")).toBeTruthy();
    expect(screen.getByText("no change")).toBeTruthy();
    expect(screen.getByText("No comparison")).toBeTruthy();
  });

  it("formats share changes as points", () => {
    render(<Delta value={-0.05} format="pts" />);
    expect(screen.getByText("down 5.00 pts, worse")).toBeTruthy();
  });

  it("breaks the sparkline at missing values and draws nothing with fewer than two", () => {
    const { container, rerender } = render(<Sparkline values={[1, 2, null, 4, 5]} />);
    expect(container.querySelectorAll("polyline")).toHaveLength(2);
    rerender(<Sparkline values={[1, null]} />);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("shows label, value, comparison, period and source", () => {
    render(<KpiCard label="Clicks" value="1,204" delta={{ value: 0.1 }} period="vs previous 28 days" source="Search Console" />);
    expect(screen.getByText("Clicks")).toBeTruthy();
    expect(screen.getByText("1,204")).toBeTruthy();
    expect(screen.getByText("up 10.0%, better")).toBeTruthy();
    expect(screen.getByText(/vs previous 28 days/)).toBeTruthy();
    expect(screen.getByText(/Search Console/)).toBeTruthy();
  });
});

describe("Field", () => {
  it("wires the label, hint and error to the control", () => {
    render(<Field label="Domain" hint="Without https://" error="Enter a domain" required>{(props) => <input {...props} />}</Field>);
    const input = screen.getByLabelText(/Domain/);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = input.getAttribute("aria-describedby") ?? "";
    expect(described.split(" ").map((id) => document.getElementById(id)?.textContent)).toEqual(expect.arrayContaining(["Without https://", "Enter a domain"]));
  });
});

describe("RouteTabs, ChartFrame and PageHeader", () => {
  it("marks the current tab as the current page", () => {
    render(<MemoryRouter><RouteTabs label="Sections" current="b" tabs={[{ id: "a", label: "A", to: "/a" }, { id: "b", label: "B", to: "/b" }]} /></MemoryRouter>);
    expect(screen.getByRole("link", { name: "B" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "A" }).getAttribute("aria-current")).toBeNull();
  });

  it("gives charts a text summary and an honest empty state", () => {
    const { rerender } = render(<ChartFrame title="Clicks" summary="Clicks rose from 10 to 40."><div>chart</div></ChartFrame>);
    expect(screen.getByRole("img", { name: "Clicks. Clicks rose from 10 to 40." })).toBeTruthy();
    rerender(<ChartFrame title="Clicks" summary="none" empty emptyText="No clicks recorded."><div>chart</div></ChartFrame>);
    expect(screen.getByText("No clicks recorded.")).toBeTruthy();
    expect(screen.queryByText("chart")).toBeNull();
  });

  it("renders one h1 with eyebrow and actions", () => {
    render(<PageHeader eyebrow="SEO Research" title="Keywords" subtitle="Ideas" action={<button>Run</button>} />);
    expect(screen.getByRole("heading", { level: 1, name: "Keywords" })).toBeTruthy();
    expect(screen.getByText("SEO Research")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
  });
});
