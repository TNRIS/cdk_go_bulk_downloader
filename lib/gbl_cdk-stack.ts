import {
  aws_codebuild,
  aws_events_targets,
  aws_iam,
  aws_sns,
  aws_sns_subscriptions,
  Stack,
  StackProps,
  Tags
} from "aws-cdk-lib";

import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class GblCdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    //////////////////////////////////////////////////
    // AWS IAM INFRASTRUCTURE
    //////////////////////////////////////////////////

    // Add a tag to this stack and all child infrastructure.
    Tags.of(this).add("bulk_downloader", "bulk_downloader")

    // Import the output bucket.
    const outbucket = s3.Bucket.fromBucketName(
      this,
      "outbucket",
      "bulk-download-output-110722"
    );

    //// retrieve existing AdministratorAccess managed policy
    const administrator_access = aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
      "AdministratorAccess"
    );
    const principal = new aws_iam.ServicePrincipal("codebuild");
    const buildrole = new aws_iam.Role(this, "bdl_buildrole", {
      assumedBy: principal,
      managedPolicies: [administrator_access],
      roleName: "bdl_buildrole",
    });

    //////////////////////////////////////////////////
    // CODEBUILD CDK CONSTRUCTS
    //////////////////////////////////////////////////

    //// codebuild project constructs
    const bdl_codebuild_project = new aws_codebuild.Project(
      this,
      "bdl_codebuild_project",
      {
        projectName: "bdl_codebuild_project",
        role: buildrole,
        environment: {
          buildImage: aws_codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
          privileged: true
        },
        artifacts: aws_codebuild.Artifacts.s3({
          bucket: outbucket,
          includeBuildId: false,
          packageZip: false,
          encryption: false
        }),
        source: aws_codebuild.Source.gitHub({
          owner: 'TNRIS',
          repo: 'go-bulk-downloader',
          webhook: true,
          webhookTriggersBatchBuild: false,
          webhookFilters: [
          aws_codebuild.FilterGroup
            .inEventOf(aws_codebuild.EventAction.PULL_REQUEST_MERGED)
          ],
        }),
        buildSpec: aws_codebuild.BuildSpec.fromObject({
          version: "0.2",
          env: {
          "secrets-manager": {
            "d_username": "dockerhubAccessToken:username",
            "d_password": "dockerhubAccessToken:password"
          }
          },
          phases: {
          install: {
            'runtime-versions': {
            golang: 1.18
          }, commands: [
              "docker --version",
              "go install github.com/fyne-io/fyne-cross@latest",
            ]
          },
          pre_build: {
            commands: [
              "ls",
              "docker login -p $d_password -u $d_username"
            ],
          },
          build: {
            commands: [
              "git clone https://github.com/TNRIS/go-bulk-downloader.git",
              "cd go-bulk-downloader/",
              "fyne-cross windows",
              "fyne-cross linux",
              "ls"
            ],
          }
          },
          artifacts: {
            files: [
              "windows-amd64/go-bulk-downloader.exe.zip",
              "linux-amd64/go-bulk-downloader.tar.xz"
            ],
            "discard-paths": "yes",
            "base-directory": "go-bulk-downloader/fyne-cross/dist/"
          }
        })
      });

    ////////////////////////////
    // EXTRA BUILD NOTIFICATIONS
    ////////////////////////////

    //// pre-create subscription to assign to topic
    const all_subscription = new aws_sns_subscriptions.EmailSubscription(
      "TNRIS_IS_Support@twdb.texas.gov"
    );

    //// create topic 
    const build_notify_topic = new aws_sns.Topic(
      this,
      "bdl_build_topic",
      {
        displayName: "bdl_cicd_builds",
        topicName: "bdl-cicd-builds",
      }
    );
    //// assign subscriptions to topic
    build_notify_topic.addSubscription(all_subscription);

    //// notify on dev failure
    bdl_codebuild_project.onBuildFailed("bdl_dev_build_failed", {
      target: new aws_events_targets.SnsTopic(build_notify_topic),
    });
  }
}
