import * as readline from "readline/promises"
import chalk from "chalk"
import { ORCHESTRATOR_SYSTEM_PROMPT as orchestratorSystemPrompt } from "./prompts/orchestrator-agent-prompt";
import { SYSTEM_PROMPT as instructions } from "./prompts/coding-agent-prompt";
import { openai } from "@ai-sdk/openai";
import { ToolLoopAgent, type ModelMessage } from "ai";
import { ModalClient, Sandbox } from "modal";
import { createNewFile, readFile, editFile, grep, listFiles, checkLint, type ToolContext, updateDatabase } from "./tools/coding";
import { createTasks, doTask, explore } from "./tools/call-sub-agent";

const modal = new ModalClient({
    tokenId: process.env.MODAL_TOKEN_ID,
    tokenSecret: process.env.MODAL_TOKEN_SECRET,
})

const app = await modal.apps.fromName("bun-nitro-pg", {
    createIfMissing: true,
});
const image = modal.images.fromRegistry("joentze/bun-nitro-pg:latest");



const tools = (sandbox: Sandbox) => {
    return {
        "list-files": listFiles({ sandbox }),
        "read-file": readFile({ sandbox }),
        "edit-file": editFile({ sandbox }),
        "create-new-file": createNewFile({ sandbox }),
        "grep": grep({ sandbox }),
        "check-lint": checkLint({ sandbox }),
        "update-database": updateDatabase({ sandbox })
    } as const
}



// start cli
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
})

const coding = ({ sandbox, addedInstructions = "" }: { sandbox: Sandbox, addedInstructions?: string }) => new ToolLoopAgent({
    instructions: [instructions, addedInstructions].join("/n/n"),
    model: openai("gpt-5.3-codex"),
    tools: tools(sandbox),
})

const orchestratorTools = (ctx: ToolContext) => {
    return {
        "explore-codebase": explore(ctx),
        "create-tasks": createTasks(ctx),
        "do-task": doTask(ctx)
    } as const
}

const orchestrator = ({ sandbox }: { sandbox: Sandbox }) => new ToolLoopAgent({
    instructions: orchestratorSystemPrompt,
    model: openai("gpt-5.3-codex"),
    tools: orchestratorTools({ sandbox }),
    providerOptions: {
        openai: {
            parallelToolCalls: false,
        }
    }
})


async function main() {

    try {
        console.log(chalk.magenta("Starting Sandbox"))
        const sandbox = await modal.sandboxes.create(app, image,
            {
                workdir: "/app",
                command: [
                    "sh", "-c",
                    `pg_ctlcluster $(pg_lsclusters -h | awk 'NR==1{print $1, $2}') start && \
until pg_isready -q; do sleep 0.5; done && \
su - postgres -c "psql -c \\"ALTER USER postgres PASSWORD 'postgres';\\"" && \
cd /app && bunx drizzle-kit generate && bunx drizzle-kit push && \
bun run dev:host`,
                ],
                encryptedPorts: [3000],
                cpu: 1,
                cpuLimit: 2,
                memoryMiB: 1024,
                memoryLimitMiB: 4096,
                blockNetwork: false,
                timeoutMs: 600000, // 5 minutes
            })
        const tunnels = await sandbox.tunnels();
        const url = tunnels["3000"]?.url;
        console.log(chalk.magenta("Sandbox URL:"), url)
        console.log(chalk.magenta("Sandbox started:"))
        console.log(chalk.magentaBright(url))
        const messages: ModelMessage[] = []


        while (true) {
            const userInput = await rl.question(chalk.green(": "))
            if (userInput.toLowerCase() === "/exit") break
            if (!userInput.trim()) continue

            messages.push({ role: "user", content: [{ type: "text", text: userInput }] })
            const { fullStream } = await coding({ sandbox }).stream({ messages })

            let assistantText = ""
            for await (const part of fullStream) {
                switch (part.type) {
                    case "text-delta":
                        process.stdout.write(part.text)
                        assistantText += part.text
                        break
                    case "tool-call":
                        console.log(chalk.dim(`[calling ${part.toolName}]`))
                        break
                    case "tool-result":
                        console.log(chalk.dim(`[${part.toolName} done]`))
                        break
                }
            }
            console.log()

            if (assistantText) {
                messages.push({ role: "assistant", content: [{ type: "text", text: assistantText }] })
            }
        }

        // exit sandbox
        await sandbox.terminate()
    } catch (error) {
        console.error(chalk.red("Error:"), error)
    } finally {
        console.log(chalk.magenta("Exited Sandbox"))
        console.log(chalk.magenta("Session ended"))
        rl.close()
    }
}

main()