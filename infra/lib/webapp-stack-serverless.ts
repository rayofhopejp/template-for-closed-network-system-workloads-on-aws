import { CfnOutput,Duration,aws_codecommit, aws_ec2, StackProps, Stack,custom_resources,CustomResource,aws_lambda_nodejs,aws_lambda } from 'aws-cdk-lib';
import { Bastion } from './constructs/ec2/bastion';
import { Construct } from 'constructs';
import { ServerlessAppBase } from './constructs/apigw/serverless-app-base';
import { CodePipelineServerless } from './constructs/codepipeline/codepipline-serverless';
import { Network } from './constructs/network/network';
import { NagSuppressions } from 'cdk-nag';
import * as path from 'path'

interface WebappStackServerlessProps extends StackProps {
  auroraSecretName: string;
  auroraSecretArn: string;
  auroraSecurityGroupId: string;
  auroraSecretEncryptionKeyArn: string;
  auroraEdition:string;
  rdsProxyEndpoint:string;
  rdsProxyArn:string;
  containerRepositoryName: string;
  enabledPrivateLink: boolean;
  testVpcCidr: string;
  sourceRepositoryName: string;
  vpcId: string;
  windowsBastion: boolean;
  linuxBastion: boolean;
  domainName: string;
  certificateArn: string;
}

export class WebappStackServerless extends Stack {
  constructor(scope: Construct, id: string, props: WebappStackServerlessProps) {
    super(scope, id, props);

    // Import vpc
    const vpc = aws_ec2.Vpc.fromLookup(this, 'WebappBaseVpc', {
      isDefault: false,
      vpcId: props.vpcId,
    });

    // Import repository
    const webappSourceRepository = aws_codecommit.Repository.fromRepositoryName(
      this,
      'WebappSourceRepository',
      props.sourceRepositoryName
    );

    let serverlessBase;
    if (props.enabledPrivateLink) {
      const privateLinkVpc = new Network(this, `PrivatelinkNetwork`, {
        cidr: '10.0.0.0/16',
        cidrMask: 24,
        publicSubnet: false,
        isolatedSubnet: true,
        maxAzs: 2,
      });
      serverlessBase = new ServerlessAppBase(this, `WebappBase`, {
        vpc: vpc,
        privateLinkVpc: privateLinkVpc.vpc,
        domainName: props.domainName,
        certificateArn: props.certificateArn,
        auroraSecretName: props.auroraSecretName,
        auroraSecretArn: props.auroraSecretArn,
        auroraSecurityGroupId: props.auroraSecurityGroupId,
        auroraSecretEncryptionKeyArn: props.auroraSecretEncryptionKeyArn,
        auroraEdition:props.auroraEdition,
        rdsProxyEndpoint:props.rdsProxyEndpoint,
        rdsProxyArn:props.rdsProxyArn
      });
    } else {
      serverlessBase = new ServerlessAppBase(this, `WebappBase`, {
        vpc: vpc,
        domainName: props.domainName,
        certificateArn: props.certificateArn,
        auroraSecretName: props.auroraSecretName,
        auroraSecretArn: props.auroraSecretArn,
        auroraSecurityGroupId: props.auroraSecurityGroupId,
        auroraSecretEncryptionKeyArn: props.auroraSecretEncryptionKeyArn,
        auroraEdition:props.auroraEdition,
        rdsProxyEndpoint:props.rdsProxyEndpoint,
        rdsProxyArn:props.rdsProxyArn
      });
    }

    // Create Deploy Pipeline
    new CodePipelineServerless(this, `WebappCodePipeline`, {
      codeCommitRepository: webappSourceRepository,
      s3bucket: serverlessBase.webapps3bucket,
    });

    if (props.windowsBastion || props.linuxBastion) {
      const bastionSecurityGroup = new aws_ec2.SecurityGroup(this, 'BastionSecurityGroup', {
        vpc,
      });
      vpc.addInterfaceEndpoint('BastionSsmVpcEndpoint', {
        service: aws_ec2.InterfaceVpcEndpointAwsService.SSM,
        subnets: { subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [bastionSecurityGroup],
      });

      vpc.addInterfaceEndpoint('BastionSsmMessagesVpcEndpoint', {
        service: aws_ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
        subnets: { subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [bastionSecurityGroup],
      });

      vpc.addInterfaceEndpoint('BastionEc2MessagesVpcEndpoint', {
        service: aws_ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
        subnets: { subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED },
        securityGroups: [bastionSecurityGroup],
      });
      // S3's vpc endpoint for yum repo has already been attached in serverless-app-base construct

      if (props.windowsBastion) {
        const windowsBastion = new Bastion(this, `Windows`, {
          os: 'Windows',
          vpc: vpc,
          region: this.region,
          auroraSecurityGroupId: props.auroraSecurityGroupId,
        });
        bastionSecurityGroup.addIngressRule(
          aws_ec2.Peer.ipv4(`${windowsBastion.bastionInstance.instancePrivateIp}/32`),
          aws_ec2.Port.tcp(443)
        );

        serverlessBase.alb.connections.allowFrom(windowsBastion.bastionInstance, aws_ec2.Port.tcp(443));
      }

      if (props.linuxBastion) {
        const linuxBastion = new Bastion(this, `Linux`, {
          os: 'Linux',
          vpc: vpc,
          region: this.region,
          auroraSecurityGroupId: props.auroraSecurityGroupId,
        });
        bastionSecurityGroup.addIngressRule(
          aws_ec2.Peer.ipv4(`${linuxBastion.bastionInstance.instancePrivateIp}/32`),
          aws_ec2.Port.tcp(443)
        );

        serverlessBase.alb.connections.allowFrom(linuxBastion.bastionInstance, aws_ec2.Port.tcp(443));
      }
    }

     ///////////////////////////
    // Initialize Aurora DB  //
    ///////////////////////////
    const initfunc = new aws_lambda_nodejs.NodejsFunction(
        this, 'dbinitlambda',{
          entry:path.join(__dirname, '../functions/init.ts'),
          runtime:aws_lambda.Runtime.NODEJS_18_X,
          role:serverlessBase.lambdaFunctionRole,
          timeout: Duration.seconds(600),
          environment: {
            SECRET_NAME: props.auroraSecretName,
            REGION: vpc.env.region.toString(),
            HOST: props.rdsProxyEndpoint
          },
          vpc:vpc,
          vpcSubnets:vpc.selectSubnets({ subnetType: aws_ec2.SubnetType.PRIVATE_ISOLATED }),
          securityGroups:[serverlessBase.sgForLambda],
          architecture: aws_lambda.Architecture.ARM_64,
          memorySize: 256,
          bundling: {
            forceDockerBundling: false, 
            define: {},
            minify: true,
          }
        }
      );
  
      const provider = new custom_resources.Provider(
        this, 'DBInitProvider',{
          onEventHandler:initfunc,
        }
    )
  
    const dbinitResource = new CustomResource(
        this, 'DBInitResource',{
         serviceToken:provider.serviceToken,
         properties:{
            time:Date.now().toString()
         }
        }
    )

    // [CHANGE HERE] Nag suppressions with path : you need to change here for deployment...
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      "/RayohopeDevTemplateappWebapp/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource",
      [
        {
          id: "AwsSolutions-IAM4",
          reason: "CDK managed resource",
          appliesTo: ["Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
        },
      ]
    );
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      "/RayohopeDevTemplateappWebapp/AWS679f53fac002430cb0da5b7982bd2287/Resource",
      [
        {
          id: "AwsSolutions-L1",
          reason: "CDK managed resource",
        },
      ]
    );
    NagSuppressions.addResourceSuppressions(provider, [
        {
          id: 'AwsSolutions-L1',
          reason: 'This is Custom Resource managed by AWS',
        },
      ],true);
      NagSuppressions.addResourceSuppressions(provider, [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'This is Custom Resource managed by AWS',
        },
      ],true);
      NagSuppressions.addResourceSuppressions(provider, [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'This is Custom Resource managed by AWS',
        },
      ],true);
  }
}
