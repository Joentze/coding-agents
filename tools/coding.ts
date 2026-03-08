import { generateText, Output, pruneMessages, tool, type ModelMessage } from "ai"
import { z } from "zod"
import { Sandbox } from "modal"
import { openai } from "@ai-sdk/openai"

interface ToolContext {
    sandbox: Sandbox
    sandboxId?: string
    workdir?: string
}
const timeoutMs = 60000
const codebaseWorkDir = "/app"



async function runCommand(
    args: string[],
    { sandbox, workdir = codebaseWorkDir, timeoutMs: commandTimeoutMs = timeoutMs }: ToolContext & { timeoutMs?: number }
) {
    try {
        const command = await sandbox.exec(args, { workdir, timeoutMs: commandTimeoutMs })
        const [stdout, stderr] = await Promise.all([command.stdout.readText(), command.stderr.readText()])
        return [stdout, stderr] as const
    } catch (error) {
        console.error(error)
        throw error
    }
}



async function catFile({ path }: { path: string }, { sandbox, workdir = codebaseWorkDir }: ToolContext) {
    return runCommand(["cat", path], { sandbox, workdir })
}

async function runUpdateDatabaseCommand({ sandbox, workdir = codebaseWorkDir }: ToolContext) {
    return runCommand(["bun", "run", "db:push"], { sandbox, workdir })
}

async function runSqlQuery({ query, sandbox, workdir = codebaseWorkDir }: ToolContext & { query: string }) {
    return runCommand(["bun", "db:command", query], { sandbox, workdir })
}

async function installBunDependencies(
    { packages, dev = false }: { packages: string[]; dev?: boolean },
    { sandbox, workdir = codebaseWorkDir }: ToolContext
) {
    return runCommand(["bun", "add", ...(dev ? ["-d"] : []), ...packages], {
        sandbox,
        workdir,
        timeoutMs: 120000,
    })
}

async function createFileBash({ path, prompt }: { path: string, prompt: string }, { sandbox, workdir = codebaseWorkDir, messages: messageHistory }: ToolContext & { messages: ModelMessage[] }) {
    const messages = [...messageHistory, userModelMessageGenerateText({ prompt })]
    const { output: { content } } = await generateText({
        messages, model: openai("gpt-5.3-codex"), output: Output.object({
            schema: z.object({
                content: z.string().describe("the content of the file to create, only the relevant code, no other text"),
            }),
        })
    })
    const delimiter = "EOFMARKER_" + Math.random().toString(36).slice(2)
    const quotedPath = "'" + path.replace(/'/g, "'\\''") + "'"
    const script = `mkdir -p "$(dirname -- ${quotedPath})" && cat <<'${delimiter}' > ${quotedPath}
${content}
${delimiter}`;
    return runCommand(["bash", "-lc", script], { sandbox, workdir })
}

const userModelMessageGenerateText = ({ prompt }: { prompt: string }): ModelMessage => {
    return {
        role: "user",
        content: [
            {
                type: "text",
                text: prompt
            }
        ]
    }
}

const listFiles = ({ sandbox, workdir = codebaseWorkDir }: ToolContext) => {
    return tool({
        description: "lists files in a relative path, using \`ls -l <path>\` under the hood",
        inputSchema: z.object({
            path: z.string().describe(`the relative path to the directory to list files from`),
        }),
        execute: async ({ path }) => {
            const command = await sandbox.exec(["ls", "-l", path], { workdir, timeoutMs })
            const [stdout, stderr] = await Promise.all([command.stdout.readText(), command.stderr.readText()])
            return `
            stdout: ${stdout}
            stderr: ${stderr ? stderr : "no errors"}
            `
        }
    })
}

const readFile = ({ sandbox, workdir = codebaseWorkDir }: ToolContext) => {
    return tool({
        description: "reads a file in a relative path, using \`cat <path>\` under the hood",
        inputSchema: z.object({
            path: z.string().describe(`the relative path to the file to read`),
        }),
        execute: async ({ path }) => {
            const [stdout, stderr] = await catFile({ path }, { sandbox, workdir })
            return `
            stdout: ${stdout}
            stderr: ${stderr ? stderr : "no errors"}
            `
        }
    })
}

const createNewFile = ({ sandbox, workdir = codebaseWorkDir }: ToolContext) => {
    return tool({
        description: "creates a new file in a relative path",
        inputSchema: z.object({
            path: z.string().describe(`the relative path to the file to create. For example: "src/components/Button.tsx"`),
            prompt: z.string().describe(`a prompt to describe the file to create`),
        }),
        execute: async ({ path, prompt }, { messages }) => {
            const [stdout, stderr] = await createFileBash({ path, prompt }, { sandbox, workdir, messages })
            return `
            stdout: ${stdout}
            stderr: ${stderr ? stderr : "no errors"}
            `
        }
    })
}

const editFile = ({ sandbox, workdir = codebaseWorkDir }: ToolContext) => {
    return tool({
        description: "edits a file in a relative path",
        inputSchema: z.object({
            path: z.string().describe(`the relative path to the file to edit`),
            prompt: z.string().describe(`a prompt to describe the changes to make`),
        }),
        execute: async ({ path, prompt }, { messages: messageHistory }) => {
            const [currentFileContent, catFileError] = await catFile({ path }, { sandbox, workdir })
            if (catFileError) {
                throw new Error(`Error reading file: ${catFileError}`)
            }
            const updateFilePrompt = `
            Current file content:
            \`\`\`
            ${currentFileContent}
            \`\`\`
            Edit the file based on the following prompt:
            \`\`\`
            ${prompt}
            \`\`\`
            Do not change other details apart from the prompt.
            `
            const [stdout, stderr] = await createFileBash({ path, prompt: updateFilePrompt }, { sandbox, workdir, messages: messageHistory })
            return `
            stdout: ${stdout}
            stderr: ${stderr ? stderr : "no errors"}
            `
        }
    })
}

const ignoreDirs = [
    "node_modules",
    "dist",
    ".next",
    "database",
]


const grep = ({ sandbox, workdir = codebaseWorkDir }: ToolContext) => {
    return tool({
        description: "searches for files with content matching the given pattern recursively in the working directory",
        inputSchema: z.object({
            pattern: z.string().describe(`the pattern to search for`),
        }),
        execute: async ({ pattern }) => {
            const excludeFlags = ignoreDirs.flatMap(dir => ["--exclude-dir", dir])
            const command = await sandbox.exec(["grep", "-ri", ...excludeFlags, pattern, "."], { workdir, timeoutMs })
            const [stdout, stderr] = await Promise.all([command.stdout.readText(), command.stderr.readText()])
            return `
            stdout: ${stdout}
            stderr: ${stderr ? stderr : "no errors"}
            `
        }
    })
}

const checkLint = ({ sandbox, workdir = codebaseWorkDir }: ToolContext) => {
    return tool({
        description: "checks for lint errors in the codebase",
        inputSchema: z.object({}),
        execute: async () => {
            const command = await sandbox.exec(["bun", "lint"], { workdir, timeoutMs })
            const [stdout, stderr] = await Promise.all([command.stdout.readText(), command.stderr.readText()])
            return `
            stdout: ${stdout}
            stderr: ${stderr ? stderr : "no errors"}
            `
        }
    })
}

const updateDatabase = ({ sandbox, workdir }: ToolContext) => {
    return tool({
        description: "use this tool when you have made schema changes in drizzle orm",
        inputSchema: z.object({}),
        execute: async () => {
            const [stdout, stderr] = await runUpdateDatabaseCommand({ sandbox, workdir })
            return `
            stdout: ${stdout}
            stderr: ${stderr ? stderr : "no errors"}
            `
        }
    })
}

const sqlQuery = ({ sandbox, workdir }: ToolContext) => {
    return tool({
        description: "use this tool to run \`select\`,\`insert\`,\`update\` sql query statements, check \`./src/db/schema.ts\` before running sql query, you can use this tool to seed database",
        inputSchema: z.object({
            query: z.string().describe("SQL query to be run, DO NOT run \`DROP\`, \`CREATE\` statements")
        }),
        execute: async ({ query }) => {
            const [stdout, stderr] = await runSqlQuery({ query, sandbox, workdir })
            return `
            stdout: ${stdout}
            stderr: ${stderr ? stderr : "no errors"}
            `
        }
    })
}

const installDependencies = ({ sandbox, workdir = codebaseWorkDir }: ToolContext) => {
    return tool({
        description: "installs one or more project dependencies with bun add",
        inputSchema: z.object({
            packages: z.array(z.string()).min(1).describe("one or more package names to install"),
            dev: z.boolean().default(false).describe("install as devDependencies when true"),
        }),
        execute: async ({ packages, dev }) => {
            const [stdout, stderr] = await installBunDependencies({ packages, dev }, { sandbox, workdir })
            return `
            stdout: ${stdout}
            stderr: ${stderr ? stderr : "no errors"}
            `
        }
    })
}

const generateDesignTheme = ({ }: ToolContext) => {
    return tool({
        description: `use this tool to generate unique designs for the frontend`,
        inputSchema: z.object({
            description: z.string().describe("brief description of the application to be created, 5-10 words")
        }),
        execute: async ({ description }) => {
            const messages = [userModelMessageGenerateText({
                prompt: `
                generate design theme for: ${description}
                `})]
            try {
                const { output: { theme, baseColors, typography, componentLayout } } = await generateText({
                    model: openai("gpt-5-nano"),
                    system: `You are a talented frontend designer, you define 
                how the app should look for its function, you are creative
                and you **SHOULD NOT** use cliche designs like purple / blue,

                If the user is asking for something more artistically inclined,
                like 'bookstore', 'cafe', 'app', you should describe themes that
                have a more hipster feel

                If the user is asking for something more tech / science related,
                like 'start-up' website, you should describe themes that give it
                a respectable, clean design
                `,
                    messages,
                    output: Output.object({
                        schema: z.object({
                            theme: z.string().describe("brief description of the app's theme 10-15 words"),
                            baseColors: z.array(z.string()).describe("list colors for the app, that fit its function"),
                            typography: z.enum(["serif", "mono", "regular"]).default("regular"),
                            componentLayout: z.string().describe("describe how shadcn components should be used to layout the app, 15-30 words")
                        })
                    })
                })
                return `
                Build: ${description}
                
                Follow the design descriptions & rules
                <descriptions>
                Theme: ${theme}
                Typography: ${typography}
                Base Colors: ${baseColors.join(", ")}
                Component Layout: ${componentLayout}
                <descriptions>

                <rules>
                - Generally speaking you should use ShadCN components & edit styles using inline Tailwind CSS
                - **DO NOT** attempt to overwrite global.css files
                - If you need to create a custom component, you can create one from scratch using React, Tailwind CSS that fits the theme
                <rules>
                `
            } catch (error) {
                console.error(error)
                throw error
            }


        }
    })
}

export { listFiles, readFile, editFile, createNewFile, grep, checkLint, updateDatabase, sqlQuery, installDependencies, type ToolContext, userModelMessageGenerateText, generateDesignTheme, installBunDependencies }
