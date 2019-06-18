####### Restarts the game server
declare server_name=$"mcm_server"
declare ID=$(aws ec2 describe-instances --filter "Name=tag:Name,Values=${server_name}" --query "Reservations[0].Instances[0].InstanceId" --output text)
echo ${ID}
# should check for pid id or some other way if the instance is running
aws ssm send-command --document-name "AWS-RunShellScript"\
 --comment "Copy data to S3 as backup / save"\
 --instance-ids ${ID}\
 --parameters file://java.json\
 --timeout-seconds 600\
 --region us-west-2