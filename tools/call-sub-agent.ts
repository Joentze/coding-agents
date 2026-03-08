import type { Sandbox } from "modal";
import { openai } from "@ai-sdk/openai"
import { SYSTEM_PROMPT as instructions } from "../prompts/coding-agent-prompt";
import {
    listFiles,
    readFile,
    createNewFile,
    checkLint,
    editFile,
    grep,
    type ToolContext,
    userModelMessageGenerateText,
    updateDatabase,
    generateDesignTheme,
    sqlQuery,
    installDependencies
} from "./coding";
import {
    tool, ToolLoopAgent
} from "ai";
import { z } from "zod";
import chalk from "chalk";
import { BACKEND_SUB_AGENT_SYSTEM_PROMPT } from "../prompts/sub-agents/backend";
import { DATABASE_SUB_AGENT_SYSTEM_PROMPT } from "../prompts/sub-agents/database";
import { FRONTEND_SUB_AGENT_SYSTEM_PROMPT } from "../prompts/sub-agents/frontend";

const tools = (ctx: ToolContext) => {
    return {
        "list-files": listFiles(ctx),
        "read-file": readFile(ctx),
        "edit-file": editFile(ctx),
        "create-new-file": createNewFile(ctx),
        "grep": grep(ctx),
        "check-lint": checkLint(ctx),
        "update-database": updateDatabase(ctx),
        "generate-design-theme": generateDesignTheme(ctx),
        "run-sql-query": sqlQuery(ctx),
        "install-dependencies": installDependencies(ctx)
    } as const
}

type CodingToolName = keyof ReturnType<typeof tools>

const coding = ({ sandbox, workdir, system, exclude = [] }: ToolContext & { addedInstructions?: string; exclude?: CodingToolName[], system?: string }) => {
    const availableTools = tools({ sandbox, workdir })

    const activeTools = Object.fromEntries(
        Object.entries(availableTools).filter(([name]) => !exclude?.includes(name as CodingToolName))
    ) as ReturnType<typeof tools>

    return new ToolLoopAgent({
        instructions: system ?? instructions,
        model: openai("gpt-5.3-codex"),
        tools: activeTools,
        toolChoice: "required"
    })
}

const agentType = z.enum(["database", "explorer", "backend", "frontend", "memory"])
type SubAgentType = z.infer<typeof agentType>

const subAgentInstructions: Record<SubAgentType, { system?: string, workdir?: string, exclude?: CodingToolName[] }> = {
    "backend": { exclude: ["generate-design-theme", "run-sql-query", "update-database"], system: BACKEND_SUB_AGENT_SYSTEM_PROMPT },
    "database": { workdir: "/app/src/db", exclude: ["generate-design-theme"], system: DATABASE_SUB_AGENT_SYSTEM_PROMPT },
    "frontend": { exclude: ["update-database", "run-sql-query"], system: FRONTEND_SUB_AGENT_SYSTEM_PROMPT },
    "explorer": { exclude: ["create-new-file", "edit-file", "check-lint", "generate-design-theme", "install-dependencies"] },
    "memory": {}
}

function createSubAgent({ type, workdir = "/app", sandbox }: ToolContext & { type: SubAgentType }) {
    const { system, exclude, workdir: specifiedWorkDir } = subAgentInstructions[type]
    console.log(chalk.green(`Calling Sub-agent: ${type}`))
    return coding({ workdir: specifiedWorkDir ?? workdir, sandbox, system, exclude })
}

function explore(ctx: ToolContext) {
    return tool({
        description: "Explore codebase to have a better understanding of structure for user's request, use at the start",
        inputSchema: z.object({ purpose: z.string() }),
        execute: async function ({ purpose }, { abortSignal }) {
            const explorer = createSubAgent({ type: "explorer", ...ctx })
            const { text: result } = await explorer.generate({
                prompt: `Briefly explore the codebase to understand how best 
                to write code for stated purpose, give a succint report on how
                and where to write files
                
                ## Purpose:
                ${purpose}
                `,
                abortSignal,
            });
            console.log(chalk.blue(`Exploration Results: ${result.slice(500)}...`))
            return `Exploration Results: ${result}`

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
        execute: async function ({ type, prompt, taskNumber }, { abortSignal, messages }) {
            console.log(chalk.cyan(`Doing Task ${taskNumber}: ${prompt.slice(10)}... `))
            const agent = createSubAgent({ ...ctx, type })
            const { text } = await agent.generate({
                messages: [...messages, userModelMessageGenerateText({ prompt })],
                abortSignal,
                onStepFinish: ({ toolCalls }) => {
                    console.log(chalk.yellow(`Type: ${toolCalls.map(({ toolName }) => toolName).join(", ")}...`))
                }
            })
            return `Task ${taskNumber} Completed: ${text}`
        },
    })
}

function createTasks(ctx: ToolContext) {
    return tool({
        description: "Create a list of atomic tasks (minimal overlap with one another) when the task is complex & involves more than just frontend design",
        inputSchema: z.object({
            tasks: z.array(z.object({
                taskNumber: z.number(),
                type: agentType.exclude(["memory", "explorer"]),
                task: z.string().describe("describe the task to carry out, 10-15 words")
            }))
        }),
        execute: ({ tasks }) => {
            return tasks.map(({ task, taskNumber, type }) => `[Task Number ${taskNumber}, Type: ${type}]: ${task}`).join("/n/n")
        }
    })
}

export { explore, doTask, createTasks, tools }