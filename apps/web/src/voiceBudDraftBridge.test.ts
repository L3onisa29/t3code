import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  VoiceBudDraftId,
  VoiceBudRecordingId,
  VoiceBudRequestId,
  type VoiceBudTranscriptionEvent,
} from "@t3tools/contracts";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "./composerDraftStore";
import { applyVoiceBudTranscription } from "./voiceBudDraftBridge";

const ENVIRONMENT = EnvironmentId.make("environment-a");
const THREAD_A = scopeThreadRef(ENVIRONMENT, ThreadId.make("thread-a"));
const THREAD_B = scopeThreadRef(ENVIRONMENT, ThreadId.make("thread-b"));

function resetStore() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

function transcription(
  target: VoiceBudTranscriptionEvent["target"],
  transcript: string,
): VoiceBudTranscriptionEvent {
  return {
    deliveryId: VoiceBudRequestId.make("delivery"),
    recordingId: VoiceBudRecordingId.make("recording"),
    target,
    transcript,
  };
}

describe("VoiceBud draft delivery", () => {
  beforeEach(resetStore);

  it("appends only to the originally bound thread after switching chats", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(THREAD_A, "existing");
    store.setPrompt(THREAD_B, "other chat");

    expect(
      applyVoiceBudTranscription(
        transcription(
          {
            _tag: "Thread",
            environmentId: THREAD_A.environmentId,
            threadId: THREAD_A.threadId,
          },
          "dictated text",
        ),
        () => true,
      ),
    ).toBe(true);
    expect(store.getComposerDraft(THREAD_A)?.prompt).toBe("existing dictated text");
    expect(store.getComposerDraft(THREAD_B)?.prompt).toBe("other chat");
  });

  it("supports independent concurrent deliveries and preserves existing text", () => {
    const firstDraft = DraftId.make("draft-a");
    const secondDraft = DraftId.make("draft-b");
    const projectRef = scopeProjectRef(ENVIRONMENT, ProjectId.make("project-a"));
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, firstDraft);
    store.setProjectDraftThreadId(
      scopeProjectRef(ENVIRONMENT, ProjectId.make("project-b")),
      secondDraft,
    );
    store.setPrompt(firstDraft, "first ");
    store.setPrompt(secondDraft, "second");

    expect(
      applyVoiceBudTranscription(
        transcription({ _tag: "Draft", draftId: VoiceBudDraftId.make(secondDraft) }, "B"),
      ),
    ).toBe(true);
    expect(
      applyVoiceBudTranscription(
        transcription({ _tag: "Draft", draftId: VoiceBudDraftId.make(firstDraft) }, "A"),
      ),
    ).toBe(true);
    expect(store.getComposerDraft(firstDraft)?.prompt).toBe("first A");
    expect(store.getComposerDraft(secondDraft)?.prompt).toBe("second B");
  });

  it("fails closed for an unknown DraftId and never invokes send behavior", () => {
    expect(
      applyVoiceBudTranscription(
        transcription(
          { _tag: "Draft", draftId: VoiceBudDraftId.make("missing-draft") },
          "do not send",
        ),
      ),
    ).toBe(false);
    expect(useComposerDraftStore.getState().draftsByThreadKey).toEqual({});
  });

  it("dictates into a queued edit without changing the thread draft and rejects cancelled edits", () => {
    const store = useComposerDraftStore.getState();
    const edit = DraftId.make("queued-edit:environment-a:thread-a:run-a");
    store.setPrompt(THREAD_A, "thread draft");
    store.setPrompt(edit, "queued message");
    const event = transcription(
      { _tag: "Draft", draftId: VoiceBudDraftId.make(edit) },
      "dictation",
    );
    expect(applyVoiceBudTranscription(event)).toBe(true);
    expect(store.getComposerDraft(edit)?.prompt).toBe("queued message dictation");
    expect(store.getComposerDraft(THREAD_A)?.prompt).toBe("thread draft");
    store.clearComposerContent(edit);
    expect(applyVoiceBudTranscription(event)).toBe(false);
    expect(store.getComposerDraft(THREAD_A)?.prompt).toBe("thread draft");
  });

  it("supports empty queued edits only while their composer still owns the target", () => {
    const store = useComposerDraftStore.getState();
    const edit = DraftId.make("queued-edit:environment-a:thread-a:run-empty");
    const event = transcription(
      { _tag: "Draft", draftId: VoiceBudDraftId.make(edit) },
      "dictation",
    );
    expect(applyVoiceBudTranscription(event, () => true, edit)).toBe(true);
    expect(store.getComposerDraft(edit)?.prompt).toBe("dictation");
    store.clearComposerContent(edit);
    expect(applyVoiceBudTranscription(event, () => true, THREAD_A)).toBe(false);
    expect(store.getComposerDraft(edit)).toBeNull();
  });

  it("fails closed when the bound server thread no longer exists", () => {
    expect(
      applyVoiceBudTranscription(
        transcription(
          {
            _tag: "Thread",
            environmentId: THREAD_A.environmentId,
            threadId: THREAD_A.threadId,
          },
          "orphaned text",
        ),
        () => false,
      ),
    ).toBe(false);
    expect(useComposerDraftStore.getState().draftsByThreadKey).toEqual({});
  });
});
