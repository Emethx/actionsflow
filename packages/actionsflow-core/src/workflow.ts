import path from "path";
import fg from "fast-glob";
import yaml from "js-yaml";
import mapObj from "map-obj";
import fs from "fs-extra";
import { log } from "./log";
import {
  template,
  getTemplateStringByParentName,
  getRawTriggers,
  getTriggerWebhookBasePath,
  getAsyncStringFunctionResult,
} from "./utils";
import multimatch from "multimatch";
import {
  ITriggerContext,
  IWorkflow,
  AnyObject,
  IWorkflowData,
  OutputsMode,
  OutcomeStatus,
  ConclusionStatus,
} from "./interface";
import { TRIGGER_RESULT_ENV_PREFIX } from "./constans";

interface IGetWorkflowsOptions {
  context: ITriggerContext;
  cwd: string;
  include?: string[];
  exclude?: string[];
}
export const getWorkflowDoc = async ({
  path: filePath,
}: {
  path: string;
}): Promise<IWorkflowData> => {
  let doc: IWorkflowData | string | undefined;
  try {
    doc = yaml.safeLoad(await fs.readFile(filePath, "utf8")) as IWorkflowData;
  } catch (e) {
    log.error("Load yaml file error:", filePath, e);
    throw e;
  }
  return doc;
};
export const getWorkflow = async ({
  cwd,
  path: filePath,
  context,
}: {
  cwd: string;
  path: string;
  context: ITriggerContext;
}): Promise<IWorkflow | undefined> => {
  const relativePath = path.relative(path.resolve(cwd, "workflows"), filePath);
  const doc = await getWorkflowDoc({ path: filePath });
  if (doc && typeof doc === "object" && doc.on) {
    // handle doc on, replace variables
    if (doc.on && typeof doc.on === "object") {
      const currentEnv = doc.env || {};
      // get new env actual value of doc yml
      const newEnv: Record<string, string> = mapObj(
        currentEnv as Record<string, string>,
        (mapKey, mapValue) => {
          let newMapValueString = "";
          let isHandled = false;
          if (typeof mapValue === "string") {
            const theMapValue = mapValue as string;
            // if supported
            newMapValueString = template(
              theMapValue,
              {
                env: process.env,
                ...context,
              },
              {
                shouldReplaceUndefinedToEmpty: true,
              }
            );
            isHandled = true;
          }
          if (isHandled) {
            return [mapKey, newMapValueString];
          } else {
            return [mapKey, mapValue];
          }
        },
        {
          deep: true,
        }
      ) as Record<string, string>;
      // add env to context
      // add metadata context
      const metadata: Record<string, string> = {};
      const newContext = {
        ...context,
        env: {
          ...process.env,
          ...newEnv,
        },
        metadata,
      };

      if (doc.on) {
        const docOnKeys = Object.keys(doc.on);
        for (let i = 0; i < docOnKeys.length; i++) {
          const triggerName = docOnKeys[i];
          if (
            (doc.on as Record<string, Record<string, Record<string, string>>>)[
              triggerName
            ] &&
            (doc.on as Record<string, Record<string, Record<string, string>>>)[
              triggerName
            ].config &&
            (doc.on as Record<string, Record<string, Record<string, string>>>)[
              triggerName
            ].config.metadata
          ) {
            // run metadata function
            newContext.metadata = (await getAsyncStringFunctionResult(
              (doc.on as Record<
                string,
                Record<string, Record<string, string>>
              >)[triggerName].config.metadata,
              newContext
            )) as Record<string, string>;
          }
        }
      }

      const newOn = mapObj(
        doc.on,
        (mapKey, mapValue) => {
          let newMapValueString = "";
          let isHandled = false;
          if (typeof mapValue === "string") {
            const theMapValue = mapValue as string;
            // if supported
            newMapValueString = template(theMapValue, newContext, {
              shouldReplaceUndefinedToEmpty: true,
            });
            isHandled = true;
          }
          if (isHandled) {
            return [mapKey as string, newMapValueString];
          } else {
            return [mapKey as string, mapValue];
          }
        },
        {
          deep: true,
        }
      ) as Record<string, AnyObject>;
      doc.on = newOn;
    }

    return {
      path: filePath,
      relativePath: relativePath,
      data: doc as IWorkflowData,
    };
  } else {
    log.debug("skip empty or invalid file", filePath);
    return undefined;
  }
};
export const getWorkflows = async (
  options: IGetWorkflowsOptions
): Promise<IWorkflow[]> => {
  const { context, cwd } = options;
  const include = options.include as string[];
  const exclude = options.exclude as string[];
  const workflowsPath = path.resolve(cwd, "workflows");
  // check is folder
  const stat = await fs.lstat(workflowsPath);
  const isFile = stat.isFile();
  let entries = [];
  if (isFile) {
    // check is exist
    const isExist = await fs.pathExists(workflowsPath);
    if (isExist) {
      // relative path
      const relativePath = path.relative(
        path.resolve(cwd, "workflows"),
        workflowsPath
      );
      entries.push({
        path: workflowsPath,
        relativePath,
      });
    }
  } else {
    // get all files with json object
    let relativeEntries = await fg(["**/*.yml", "**/*.yaml"], {
      cwd: workflowsPath,
      dot: true,
    });
    const patterns: string[] = arrify(include).concat(negate(exclude));

    // filter
    if (patterns.length) {
      log.debug("workflows detect: ", relativeEntries);
      log.debug("workflows filter pattern: ", patterns);

      if (!include.length) {
        // only excludes needs to select all items first
        // globstar is for matching scoped packages
        patterns.unshift("**");
      }
      relativeEntries = multimatch(relativeEntries, patterns);
      log.debug("workflows filter results: ", relativeEntries);
    }
    entries = relativeEntries.map((relativePath) => {
      return {
        relativePath,
        path: path.resolve(workflowsPath, relativePath),
      };
    });
  }

  const workflows: IWorkflow[] = [];
  // Get document, or throw exception on error
  for (let index = 0; index < entries.length; index++) {
    const filePath = entries[index].path;
    const workflow = await getWorkflow({
      path: filePath,
      cwd: cwd,
      context: context,
    });
    if (workflow) {
      workflows.push(workflow);
    }
  }

  const validWorkflows = workflows.filter((workflow) => {
    const rawTriggers = getRawTriggers(workflow.data);
    return rawTriggers.length > 0;
  });
  return validWorkflows;
};

export const getJobsDependences = (
  jobs: Record<string, AnyObject>
): { lastJobs: string[]; firstJobs: string[] } => {
  const jobKeys = Object.keys(jobs);
  const jobsWhoHasNeeds: {
    id: string;
    needs: string[];
  }[] = [];
  const jobsNoNeeds: string[] = [];
  jobKeys.forEach((jobKey) => {
    const job = jobs[jobKey] as { needs: string[] };
    if (job && job.needs && job.needs.length > 0) {
      jobsWhoHasNeeds.push({
        id: jobKey,
        needs: job.needs,
      });
    }
    if (!job.needs || job.needs.length === 0) {
      jobsNoNeeds.push(jobKey);
    }
  });

  let lastJobs: string[] = [];
  let beNeededJobs: string[] = [];
  jobsWhoHasNeeds.forEach((job) => {
    job.needs.forEach((beNeededJob) => {
      const isBeNeeded = jobsWhoHasNeeds.find(
        (item) => item.id === beNeededJob
      );
      if (isBeNeeded) {
        beNeededJobs.push(beNeededJob);
      }
    });
  });
  beNeededJobs = [...new Set(beNeededJobs)];
  jobsWhoHasNeeds.forEach((job) => {
    if (!beNeededJobs.includes(job.id)) {
      lastJobs.push(job.id);
    }
  });
  if (lastJobs.length === 0) {
    lastJobs = jobKeys;
  }
  return { lastJobs, firstJobs: jobsNoNeeds };
};

export const renameJobsBySuffix = (
  jobs: Record<string, AnyObject>,
  suffix: string
): Record<string, AnyObject> => {
  const jobKeys = Object.keys(jobs);
  const newJobs: Record<string, AnyObject> = {};
  jobKeys.forEach((jobKey) => {
    const job = jobs[jobKey] as {
      needs: string[];
    };
    const newJobKey = `${jobKey}${suffix}`;
    if (job.needs) {
      job.needs = job.needs.map((item: string) => {
        return `${item}${suffix}`;
      });
    }
    newJobs[newJobKey] = job;
  });
  return newJobs;
};
interface IBuildSingleWorkflowOptions {
  workflow: IWorkflow;
  cwd?: string;
  trigger: {
    name: string;
    results: AnyObject[];
    outcome: OutcomeStatus;
    conclusion: ConclusionStatus;
    outputsMode?: OutputsMode;
    exportOutputs?: boolean;
    outputsDir?: string;
    resultsPerWorkflow?: number;
  };
}
export const getBuiltWorkflows = async (
  options: IBuildSingleWorkflowOptions
): Promise<IWorkflowData[]> => {
  log.trace("buildWorkflow options:", options);
  const { workflow, trigger } = options;
  const cwd = options.cwd || process.cwd();
  const { outcome, conclusion, results, resultsPerWorkflow } = trigger;
  const outputsMode = trigger.outputsMode || "separate";
  const exportOutputs = trigger.exportOutputs || false;
  const outputsDir = trigger.outputsDir || "dist/outputs";
  const workflowData = { ...workflow.data };
  // handle context expresstion
  const workflowDataJobs: Record<
    string,
    AnyObject
  > = workflowData.jobs as Record<string, AnyObject>;
  delete workflowData.jobs;
  let jobsGroups: {
    lastJobs: string[];
    firstJobs: string[];
    jobs: Record<string, AnyObject>;
  }[] = [];
  // jobs internal env
  let jobInternalEnvs: Record<string, string>[] = [];

  if (conclusion === "success") {
    if (outputsMode === "combine") {
      if (resultsPerWorkflow && results.length > resultsPerWorkflow) {
        const jobsGroupsCount = Math.ceil(results.length / resultsPerWorkflow);
        const getJobsGroupsResults = Array.from({
          length: jobsGroupsCount,
        }).map((_, index) => {
          return getJobGroups({
            cwd,
            outputs: results.slice(
              index * resultsPerWorkflow,
              (index + 1) * resultsPerWorkflow
            ),
            exportOutputs,
            outputsDir,
            outcome: outcome,
            conclusion: conclusion,
            workflowData: workflowData,
            workflowDataJobs: workflowDataJobs,
            workflowRelativePath: workflow.relativePath,
            triggerName: trigger.name,
            suffix: `${index}`,
          });
        });
        const jobsGroupsResults = await Promise.all(getJobsGroupsResults);
        jobsGroups = jobsGroupsResults.map((item) => item.jobsGroup);
        jobInternalEnvs = jobsGroupsResults.map((item) => item.jobInternalEnv);
        return jobsGroups.map((jobsGroup, index) => {
          return getWorkflowData({
            jobsGroups: [jobsGroup],
            jobInternalEnvs: [jobInternalEnvs[index]],
            workflowData,
          });
        });
      } else {
        const jobsGroupsResult = await getJobGroups({
          cwd,
          outputs: results,
          outcome: outcome,
          exportOutputs,
          outputsDir,
          conclusion: conclusion,
          workflowData: workflowData,
          workflowDataJobs: workflowDataJobs,
          workflowRelativePath: workflow.relativePath,
          triggerName: trigger.name,
        });
        jobsGroups.push(jobsGroupsResult.jobsGroup);
        jobInternalEnvs.push(jobsGroupsResult.jobInternalEnv);
      }
    } else {
      const getJobsGroupsResults = results.map((result, index) =>
        getJobGroups({
          cwd,
          outputs: result,
          outcome: outcome,
          exportOutputs,
          outputsDir,
          conclusion: conclusion,
          workflowData: workflowData,
          workflowDataJobs: workflowDataJobs,
          workflowRelativePath: workflow.relativePath,
          triggerName: trigger.name,
          suffix: `${index}`,
        })
      );
      const jobsGroupsResults = await Promise.all(getJobsGroupsResults);
      jobsGroups = jobsGroupsResults.map((item) => item.jobsGroup);
      jobInternalEnvs = jobsGroupsResults.map((item) => item.jobInternalEnv);
    }
  }

  if (resultsPerWorkflow) {
    // split jobs
    if (jobsGroups.length > resultsPerWorkflow) {
      const jobsGroupsCount = Math.ceil(jobsGroups.length / resultsPerWorkflow);
      return Array.from({ length: jobsGroupsCount }).map((_, outputsIndex) => {
        const theWorkflowData = getWorkflowData({
          jobsGroups: jobsGroups.slice(
            outputsIndex * resultsPerWorkflow,
            (outputsIndex + 1) * resultsPerWorkflow
          ),
          jobInternalEnvs: jobInternalEnvs.slice(
            outputsIndex * resultsPerWorkflow,
            (outputsIndex + 1) * resultsPerWorkflow
          ),
          workflowData,
        });
        return theWorkflowData;
      });
    } else {
      const newWorkflowData = getWorkflowData({
        jobsGroups: jobsGroups,
        jobInternalEnvs: jobInternalEnvs,
        workflowData,
      });

      return [newWorkflowData];
    }
  } else {
    const newWorkflowData = getWorkflowData({
      jobsGroups: jobsGroups,
      jobInternalEnvs: jobInternalEnvs,
      workflowData,
    });

    return [newWorkflowData];
  }
};
interface IInternalGetJobGruopsOptions {
  outputs: AnyObject[] | AnyObject;
  exportOutputs: boolean;
  outputsDir: string;
  outcome: OutcomeStatus;
  conclusion: ConclusionStatus;
  workflowData: IWorkflowData;
  workflowDataJobs: Record<string, AnyObject>;
  workflowRelativePath: string;
  triggerName: string;
  cwd: string;
  suffix?: string;
}
interface IInternalGetWorkflowDataOptions {
  workflowData: IWorkflowData;
  jobsGroups: {
    lastJobs: string[];
    firstJobs: string[];
    jobs: Record<string, AnyObject>;
  }[];
  jobInternalEnvs: Record<string, string>[];
}
function getWorkflowData(
  options: IInternalGetWorkflowDataOptions
): IWorkflowData {
  const { workflowData, jobsGroups, jobInternalEnvs } = options;
  const finalJobs: Record<string, AnyObject> = {};
  jobsGroups.forEach((jobsGroup, index) => {
    const jobs = jobsGroup.jobs;
    const jobKeys = Object.keys(jobs);

    if (index > 0) {
      jobKeys.forEach((jobKey) => {
        const job = jobs[jobKey];
        // inject envs
        job.env = {
          ...jobInternalEnvs[index],
          ...(job.env as Record<string, string>),
        };
        if (jobsGroup.firstJobs.includes(jobKey)) {
          if (Array.isArray(job.needs)) {
            job.needs = (job.needs as string[]).concat(
              jobsGroups[index - 1].lastJobs
            );
          } else {
            job.needs = jobsGroups[index - 1].lastJobs;
          }
          finalJobs[jobKey] = job;
        } else {
          finalJobs[jobKey] = job;
        }
      });
    } else {
      jobKeys.forEach((jobKey) => {
        const job = jobs[jobKey];
        // inject envs
        job.env = {
          ...jobInternalEnvs[index],
          ...(job.env as Record<string, string>),
        };
        finalJobs[jobKey] = job;
      });
    }
  });

  // finalJobs name unique for act unique name
  const finalJobKeys = Object.keys(finalJobs);
  finalJobKeys.forEach((jobKey, index) => {
    const job = finalJobs[jobKey];
    if (job.name) {
      job.name = `${job.name} ${index}`;
    } else {
      job.name = `job ${index}`;
    }

    finalJobs[jobKey] = job;
  });
  const newWorkflowData = { ...workflowData };
  newWorkflowData.on = ["push"];
  newWorkflowData.jobs = finalJobs;
  return newWorkflowData;
}
async function getJobGroups(
  options: IInternalGetJobGruopsOptions
): Promise<{
  jobsGroup: {
    lastJobs: string[];
    firstJobs: string[];
    jobs: Record<string, AnyObject>;
  };
  jobInternalEnv: Record<string, string>;
}> {
  const {
    outputs,
    exportOutputs,
    outputsDir,
    workflowData,
    workflowDataJobs,
    triggerName,
    outcome,
    conclusion,
    suffix,
    cwd,
    workflowRelativePath,
  } = options;

  const jobInternalEnv: Record<string, string> = {};
  const context: Record<string, AnyObject> = {
    on: {},
  };

  const rawTriggers = getRawTriggers(workflowData);
  // add all triggers results to env
  for (let i = 0; i < rawTriggers.length; i++) {
    const rawTrigger = rawTriggers[i];
    if (triggerName === rawTrigger.name) {
      // check is need export
      if (exportOutputs) {
        const filePath = getTriggerWebhookBasePath(
          workflowRelativePath,
          triggerName
        ).slice(1);
        const finalOutputsPath = path.resolve(
          cwd,
          outputsDir,
          `${filePath}${suffix ? "_" + suffix : ""}.json`
        );
        const finalOutputsRelativePath = path.relative(cwd, finalOutputsPath);
        await fs.outputJSON(finalOutputsPath, outputs, {
          spaces: 2,
        });
        jobInternalEnv[
          `${TRIGGER_RESULT_ENV_PREFIX}${rawTrigger.name}`
        ] = JSON.stringify(
          {
            outcome: outcome,
            conclusion: conclusion,
            outputs: {
              path: finalOutputsRelativePath,
            },
          },
          null,
          2
        );
      } else {
        jobInternalEnv[
          `${TRIGGER_RESULT_ENV_PREFIX}${rawTrigger.name}`
        ] = JSON.stringify(
          {
            outcome: outcome,
            conclusion: conclusion,
            outputs: outputs,
          },
          null,
          2
        );
      }
    } else {
      jobInternalEnv[
        `${TRIGGER_RESULT_ENV_PREFIX}${rawTrigger.name}`
      ] = JSON.stringify(
        {
          outcome: "skipped",
          conclusion: "skipped",
          outputs: {},
        },
        null,
        2
      );
    }
    context.on[
      rawTrigger.name
    ] = `(fromJSON(env.${TRIGGER_RESULT_ENV_PREFIX}${rawTrigger.name}))`;
  }

  // handle context expresstion
  let newJobs = {};
  try {
    newJobs = mapObj(
      workflowDataJobs as Record<string, unknown>,
      (key, value) => {
        value = value as unknown;

        if (typeof value === "string" && key !== "if") {
          // if supported

          value = getTemplateStringByParentName(value, "on", context);
        }
        if (key === "if" && typeof value === "string") {
          if (value.trim().indexOf("${{") !== 0) {
            value = `\${{ ${value} }}`;
          }
          value = getTemplateStringByParentName(value as string, "on", context);
        }
        return [key, value];
      },
      {
        deep: true,
      }
    );
  } catch (error) {
    throw new Error(
      `An error occurred when parsing workflow file ${workflowRelativePath}:  ${(error as Error).toString()}`
    );
  }
  let jobs = newJobs;

  if (suffix) {
    jobs = renameJobsBySuffix(
      newJobs as Record<string, AnyObject>,
      `_${suffix}`
    );
  }

  // jobs id rename for merge

  const jobsDependences = getJobsDependences(jobs);
  const jobsGroup = {
    lastJobs: jobsDependences.lastJobs,
    firstJobs: jobsDependences.firstJobs,
    jobs: jobs,
  };
  return { jobsGroup, jobInternalEnv };
}

function arrify(thing: string | string[]): string[] {
  if (!thing) {
    return [];
  }

  if (!Array.isArray(thing)) {
    return [thing];
  }

  return thing;
}

function negate(patterns: string | string[]): string[] {
  return arrify(patterns).map((pattern) => `!${pattern}`);
}
