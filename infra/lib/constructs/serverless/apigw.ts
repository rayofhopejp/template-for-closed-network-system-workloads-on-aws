import { aws_apigateway, aws_ec2, aws_iam, aws_logs } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

// private ApiGw with vpc endpoint
export class ApiGw extends Construct {
  public readonly vpcEndpointSecurityGroup: aws_ec2.SecurityGroup;
  public readonly privateApiVpcEndpoint: aws_ec2.InterfaceVpcEndpoint;
  public readonly privateApi: aws_apigateway.LambdaRestApi;
  public readonly sgForLambda: aws_ec2.SecurityGroup;
  public addResource: (resourceName: string) => aws_apigateway.Resource;
  constructor(
    scope: Construct,
    id: string,
    props: {
      vpc: aws_ec2.IVpc;
      auroraSecretName: string;
      auroraSecretArn: string;
      auroraSecurityGroupId: string;
      auroraSecretEncryptionKeyArn: string;
      auroraEdition: string;
      rdsProxyEndpoint: string;
      rdsProxyArn: string;
    }
  ) {
    super(scope, id);
    this.vpcEndpointSecurityGroup = new aws_ec2.SecurityGroup(this, 'vpcEndpointSecurityGroup', {
      vpc: props.vpc,
      allowAllOutbound: true,
    });

    // VPC endpoint
    this.privateApiVpcEndpoint = new aws_ec2.InterfaceVpcEndpoint(this, 'privateApiVpcEndpoint', {
      vpc: props.vpc,
      service: aws_ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
      privateDnsEnabled: true,
      subnets: { subnets: props.vpc.isolatedSubnets },
      securityGroups: [this.vpcEndpointSecurityGroup],
      open: false,
    });

    //Aurora and ApiGw  SG Settings
    const sgForAurora = aws_ec2.SecurityGroup.fromSecurityGroupId(
      this,
      'AuroraSecurityGroup',
      props.auroraSecurityGroupId
    );
    this.sgForLambda = new aws_ec2.SecurityGroup(this, 'ApiGwSecurityGroup', {
      vpc: props.vpc,
      allowAllOutbound: true,
    });
    if (props.auroraEdition == 'mysql') {
      sgForAurora.addIngressRule(this.sgForLambda, aws_ec2.Port.tcp(3306));
    } else {
      sgForAurora.addIngressRule(this.sgForLambda, aws_ec2.Port.tcp(5432));
    }
    // API Gateway LogGroup
    const restApiLogAccessLogGroup = new aws_logs.LogGroup(this, 'RestApiLogAccessLogGroup', {
      retention: 365,
    });

    // API Gateway
    this.privateApi = new aws_apigateway.RestApi(this, 'privateApi', {
      restApiName: `${id}-apigateway`,
      deployOptions: {
        dataTraceEnabled: true,
        loggingLevel: aws_apigateway.MethodLoggingLevel.INFO,
        accessLogDestination: new aws_apigateway.LogGroupLogDestination(restApiLogAccessLogGroup),
        accessLogFormat: aws_apigateway.AccessLogFormat.clf(),
      },
      endpointConfiguration: {
        types: [aws_apigateway.EndpointType.PRIVATE],
        vpcEndpoints: [this.privateApiVpcEndpoint],
      },
      policy: new aws_iam.PolicyDocument({
        statements: [
          new aws_iam.PolicyStatement({
            principals: [new aws_iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            effect: aws_iam.Effect.DENY,
            conditions: {
              StringNotEquals: {
                'aws:SourceVpce': this.privateApiVpcEndpoint.vpcEndpointId,
              },
            },
          }),
          new aws_iam.PolicyStatement({
            principals: [new aws_iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            effect: aws_iam.Effect.ALLOW,
          }),
        ],
      }),
    });

    // Request Validator
    this.privateApi.addRequestValidator('validate-request', {
      requestValidatorName: 'my-request-validator',
      validateRequestBody: true,
      validateRequestParameters: true,
    });
    this.addResource = (resourceName: string) => {
      return this.privateApi.root.addResource(resourceName, {
        defaultCorsPreflightOptions: {
          allowOrigins: aws_apigateway.Cors.ALL_ORIGINS,
          allowMethods: aws_apigateway.Cors.ALL_METHODS,
          allowHeaders: aws_apigateway.Cors.DEFAULT_HEADERS,
          disableCache: true,
        },
      });
    };

    // NagSuppressions
    NagSuppressions.addResourceSuppressions(
      this.vpcEndpointSecurityGroup,
      [
        {
          id: 'AwsSolutions-EC23',
          reason: 'This is Sample, so API Gateway is open to everyone.',
        },
      ],
      true
    );
  }
}
