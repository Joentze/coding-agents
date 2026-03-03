import type { Sandbox } from "modal";
import { openai } from "@ai-sdk/openai"
import { SYSTEM_PROMPT as instructions } from "../prompts/coding-agent-prompt";
import { listFiles, readFile, createNewFile, checkLint, editFile, grep, type ToolContext, userModelMessageGenerateText } from "./coding";
import { readUIMessageStream, tool, ToolLoopAgent } from "ai";
import { z } from "zod";

const tools = (ctx: ToolContext) => {
    return {
        "list-files": listFiles(ctx),
        "read-file": readFile(ctx),
        "edit-file": editFile(ctx),
        "create-new-file": createNewFile(ctx),
        "grep": grep(ctx),
        "check-lint": checkLint(ctx),
        // TODO: to add database command runner
    } as const
}

type CodingToolName = keyof ReturnType<typeof tools>

const coding = ({ sandbox, workdir, addedInstructions = "", exclude = [] }: ToolContext & { addedInstructions?: string; exclude?: CodingToolName[] }) => {
    const availableTools = tools({ sandbox, workdir })

    const activeTools = Object.fromEntries(
        Object.entries(availableTools).filter(([name]) => !exclude?.includes(name as CodingToolName))
    ) as ReturnType<typeof tools>

    return new ToolLoopAgent({
        instructions: [instructions, addedInstructions].join("/n/n"),
        model: openai("gpt-5.3-codex"),
        tools: activeTools,
    })
}

const agentType = z.enum(["database", "explorer", "backend", "frontend", "memory"])
type SubAgentType = z.infer<typeof agentType>

const subAgentInstructions: Record<SubAgentType, { addedInstructions: string, workdir?: string, exclude?: CodingToolName[] }> = {
    "backend": { addedInstructions: "" },
    "database": { addedInstructions: "", workdir: "/app/src/db" },
    "frontend": { addedInstructions: "" },
    "explorer": { addedInstructions: "", exclude: ["create-new-file", "edit-file", "check-lint"] },
    "memory": { addedInstructions: "" }
}

function createSubAgent({ type, workdir = "/app", sandbox }: ToolContext & { type: SubAgentType }) {
    const { addedInstructions, exclude, workdir: specifiedWorkDir } = subAgentInstructions[type]
    return coding({ workdir: specifiedWorkDir ?? workdir, sandbox, addedInstructions, exclude })
}

function explore(ctx: ToolContext) {
    return tool({
        description: "Explore codebase to have a better understanding of structure for user's request, use at the start",
        inputSchema: z.object({ purpose: z.string() }),
        execute: async function* ({ purpose }, { abortSignal }) {
            const explorer = createSubAgent({ type: "explorer", ...ctx })
            const result = await explorer.stream({
                prompt: `Briefly explore the codebase to understand how best 
                to write code for stated purpose, give a succint report on how
                and where to write files`,
                abortSignal,
            });

            for await (const message of readUIMessageStream({
                stream: result.toUIMessageStream(),
            })) {
                yield message;
            }
        },
        toModelOutput: ({ output: message }) => {
            const lastTextPart = message?.parts.findLast(p => p.type === 'text');
            return {
                type: 'text',
                value: lastTextPart?.text ?? 'Task completed.',
            };
        },
    })
}

function doTask(ctx: ToolContext) {
    return tool({
        description: "Execute tasks step by step, assign task to type-specific sub-agent",
        inputSchema: z.object({
            taskNumber: z.number(),
            type: agentType.exclude(["memory", "explorer"]),
            prompt: z.string()
        }),
        execute: async function* ({ type, prompt }, { abortSignal, messages }) {
            const agent = createSubAgent({ ...ctx, type })
            const result = await agent.stream({
                messages: [...messages, userModelMessageGenerateText({ prompt })],
                abortSignal
            })
            for await (const message of readUIMessageStream({
                stream: result.toUIMessageStream(),
            })) {
                yield message;
            }
        },
        toModelOutput: ({ output: message, input }) => {
            const lastTextPart = message?.parts.findLast(p => p.type === 'text');
            return {
                type: 'text',
                value: `Task number: ${input.taskNumber} has been completed, Result: ${lastTextPart?.text ?? ""}`,
            };
        },
    })
}

export { explore, doTask }